use std::sync::{Mutex, atomic::Ordering};
use std::time::Duration;

use tauri::Manager;

use crate::app_state::{ArtworkCache, RendererLifecycleState};
use crate::set_frontend_visibility;
use crate::window_state::sync_window_state;

#[cfg(target_os = "linux")]
use crate::{background_app, gnome_desktop_detected as is_gnome_desktop};

#[cfg(target_os = "linux")]
thread_local! {
    static THEATER_INHIBIT_HANDLE: std::cell::RefCell<Option<zbus::zvariant::OwnedObjectPath>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn show_window_now(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        move_window_to_active_space(&window);
        if window.show().is_ok() {
            set_frontend_visibility(app, true);
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn move_window_to_active_space(window: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
    use cocoa::base::id;

    let Ok(native_window) = window.ns_window() else {
        return;
    };

    // Keep size and coordinates persisted, but let macOS place the restored
    // window on whichever Space is active when it becomes visible.
    unsafe {
        let native_window = native_window as id;
        let behavior = native_window.collectionBehavior()
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace;
        native_window.setCollectionBehavior_(behavior);
    }
}

pub(crate) fn hide_main_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())?;
    set_frontend_visibility(app, false);
    if let Some(cache) = app.try_state::<Mutex<ArtworkCache>>()
        && let Ok(mut cache) = cache.lock()
    {
        cache.clear();
    }

    #[cfg(target_os = "linux")]
    if let Some(state) = app.try_state::<RendererLifecycleState>()
        && state.enabled.load(Ordering::Relaxed)
        && state
            .terminated
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        state.restoring.store(false, Ordering::Relaxed);
        let app_handle = app.clone();
        if let Err(err) = window.with_webview(move |webview| {
            use webkit2gtk::WebViewExt;
            webview.inner().terminate_web_process();
            eprintln!("[Viby] Background WebKit renderer terminated.");
        }) {
            if let Some(state) = app_handle.try_state::<RendererLifecycleState>() {
                state.terminated.store(false, Ordering::Relaxed);
                state.enabled.store(false, Ordering::Relaxed);
            }
            eprintln!("[Viby] Renderer termination unavailable; using window hide: {err}");
        }
    }

    Ok(())
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    THEATER_INHIBIT_HANDLE.with(|slot| {
        if let Some(handle) = slot.borrow_mut().take() {
            background_app::uninhibit_idle_session(handle);
        }
    });
    let main_window = app.get_webview_window("main");
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    if let Some(theater) = app.get_webview_window("theater") {
        if let Some(main) = main_window.as_ref() {
            sync_window_state(&theater, main);
        }
        let _ = theater.hide();
    }
    let Some(state) = app.try_state::<RendererLifecycleState>() else {
        show_window_now(app);
        return;
    };
    if !state.terminated.load(Ordering::Relaxed) {
        show_window_now(app);
        return;
    }
    if state.restoring.swap(true, Ordering::SeqCst) {
        return;
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(window) = main_window else {
        state.restoring.store(false, Ordering::Relaxed);
        return;
    };
    if let Err(err) = window.reload() {
        eprintln!("[Viby] Failed to restore background renderer: {err}");
        state.enabled.store(false, Ordering::Relaxed);
        state.terminated.store(false, Ordering::Relaxed);
        state.restoring.store(false, Ordering::Relaxed);
        show_window_now(app);
        return;
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let Some(state) = app_handle.try_state::<RendererLifecycleState>() else {
            return;
        };
        if state.generation.load(Ordering::SeqCst) != generation
            || !state.restoring.load(Ordering::Relaxed)
        {
            return;
        }
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.reload();
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        if state.generation.load(Ordering::SeqCst) == generation
            && state.restoring.swap(false, Ordering::SeqCst)
        {
            eprintln!("[Viby] Renderer restore timed out; disabling suspension for this session.");
            state.enabled.store(false, Ordering::Relaxed);
            state.terminated.store(false, Ordering::Relaxed);
            show_window_now(&app_handle);
        }
    });
}

#[tauri::command]
pub(crate) fn set_renderer_suspension_enabled(
    enabled: bool,
    state: tauri::State<RendererLifecycleState>,
) {
    state
        .enabled
        .store(cfg!(target_os = "linux") && enabled, Ordering::Relaxed);
}

#[tauri::command]
pub(crate) fn frontend_ready(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<RendererLifecycleState>() else {
        return;
    };
    if !state.restoring.swap(false, Ordering::SeqCst) {
        return;
    }
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.terminated.store(false, Ordering::Relaxed);
    show_window_now(&app);
}

#[cfg(target_os = "linux")]
fn gtk_point_hits_button(widget: &gtk::Widget, titlebar: &gtk::Widget, x: i32, y: i32) -> bool {
    use gtk::prelude::*;

    if widget.is::<gtk::Button>() && widget.is_visible() {
        let allocation = widget.allocation();
        if let Some((button_x, button_y)) = widget.translate_coordinates(titlebar, 0, 0)
            && x >= button_x
            && y >= button_y
            && x < button_x + allocation.width()
            && y < button_y + allocation.height()
        {
            return true;
        }
    }

    let Ok(container) = widget.clone().downcast::<gtk::Container>() else {
        return false;
    };
    let mut hit = false;
    container.forall(|child| {
        if !hit && gtk_point_hits_button(child, titlebar, x, y) {
            hit = true;
        }
    });
    hit
}

#[cfg(target_os = "linux")]
pub(crate) fn guard_gnome_webview_touch_from_resize<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) {
    let _ = window.with_webview(|platform_webview| {
        use gtk::glib::translate::IntoGlib;
        use gtk::prelude::*;
        use std::cell::Cell;

        let webview = platform_webview.inner();
        let widget: &gtk::Widget = webview.upcast_ref();
        let instance = widget.as_ptr() as *mut gtk::glib::gobject_ffi::GObject;
        unsafe {
            let signal_id = gtk::glib::gobject_ffi::g_signal_lookup(
                b"touch-event\0".as_ptr().cast(),
                webview.type_().into_glib(),
            );
            let handler_id = gtk::glib::gobject_ffi::g_signal_handler_find(
                instance,
                gtk::glib::gobject_ffi::G_SIGNAL_MATCH_ID,
                signal_id,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if handler_id != 0 {
                gtk::glib::gobject_ffi::g_signal_handler_disconnect(instance, handler_id);
            }
        }

        let active_touches = Cell::new(0_u32);
        let restore_resizable = Cell::new(false);
        webview.connect_touch_event(move |webview, event| {
            let window = webview
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok())
                .filter(|w| w.is_realized() && w.is_visible());
            match event.event_type() {
                gtk::gdk::EventType::TouchBegin => {
                    if active_touches.get() == 0 {
                        if let Some(window) = window {
                            restore_resizable.set(window.is_resizable());
                            window.set_resizable(false);
                        }
                    }
                    active_touches.set(active_touches.get() + 1);
                }
                gtk::gdk::EventType::TouchEnd | gtk::gdk::EventType::TouchCancel => {
                    active_touches.set(active_touches.get().saturating_sub(1));
                    if active_touches.get() == 0 && restore_resizable.replace(false) {
                        if let Some(window) = window {
                            window.set_resizable(true);
                        }
                    }
                }
                _ => {}
            }
            gtk::glib::Propagation::Proceed
        });
    });
}

#[cfg(target_os = "linux")]
pub(crate) fn enable_gnome_touch_window_drag<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use gtk::{gdk::prelude::*, prelude::*};

    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let Some(titlebar) = gtk_window.titlebar() else {
        return;
    };
    titlebar.add_events(gtk::gdk::EventMask::TOUCH_MASK);
    let gtk_window = gtk_window.downgrade();

    titlebar.connect_touch_event(move |titlebar, event| {
        if event.event_type() != gtk::gdk::EventType::TouchBegin {
            return gtk::glib::Propagation::Proceed;
        }
        let Some((x, y)) = event.coords() else {
            return gtk::glib::Propagation::Proceed;
        };
        if gtk_point_hits_button(titlebar, titlebar, x as i32, y as i32) {
            return gtk::glib::Propagation::Proceed;
        }
        let (Some(gtk_window), Some(device), Some((root_x, root_y))) =
            (gtk_window.upgrade(), event.device(), event.root_coords())
        else {
            return gtk::glib::Propagation::Proceed;
        };
        if let Some(gdk_window) = gtk_window.window() {
            gdk_window.begin_move_drag_for_device(
                &device,
                0,
                root_x as i32,
                root_y as i32,
                event.time(),
            );
            return gtk::glib::Propagation::Stop;
        }

        gtk::glib::Propagation::Proceed
    });
}

#[tauri::command]
pub(crate) fn show_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    let mini = if let Some(win) = app.get_webview_window("mini") {
        win
    } else {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "mini",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Viby")
        .decorations(false)
        .transparent(true)
        .resizable(false)
        .inner_size(420.0, 200.0)
        .skip_taskbar(true)
        .visible(false);

        let win = builder.build().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        if is_gnome_desktop() {
            guard_gnome_webview_touch_from_resize(&win);
        }

        #[cfg(target_os = "macos")]
        let _ = window_vibrancy::apply_vibrancy(
            &win,
            window_vibrancy::NSVisualEffectMaterial::Sidebar,
            None,
            Some(14.0),
        );

        #[cfg(target_os = "windows")]
        let _ = window_vibrancy::apply_mica(&win, None);

        win
    };

    let _ = mini.show();
    let _ = mini.unminimize();
    let _ = mini.set_focus();

    if let Some(main) = app.get_webview_window("main") {
        let _ = hide_main_window(&app, &main);
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn leave_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.hide();
    }
    show_main_window(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn show_theater_mode(app: tauri::AppHandle) -> Result<(), String> {
    let theater = if let Some(win) = app.get_webview_window("theater") {
        win
    } else {
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "theater",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Viby Theater")
        .decorations(false)
        .transparent(true)
        .maximized(true)
        .visible(false);

        let win = builder.build().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        if is_gnome_desktop() {
            guard_gnome_webview_touch_from_resize(&win);
        }

        #[cfg(target_os = "macos")]
        let _ = window_vibrancy::apply_vibrancy(
            &win,
            window_vibrancy::NSVisualEffectMaterial::Sidebar,
            None,
            Some(14.0),
        );

        #[cfg(target_os = "windows")]
        let _ = window_vibrancy::apply_mica(&win, None);

        win
    };

    if let Some(main) = app.get_webview_window("main") {
        sync_window_state(&main, &theater);
    }

    let _ = theater.show();
    let _ = theater.unminimize();
    let _ = theater.set_focus();

    #[cfg(target_os = "linux")]
    THEATER_INHIBIT_HANDLE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = background_app::inhibit_idle_session("Viby Theater Mode active");
        }
    });

    if let Some(main) = app.get_webview_window("main") {
        let _ = hide_main_window(&app, &main);
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn leave_theater_mode(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    THEATER_INHIBIT_HANDLE.with(|slot| {
        if let Some(handle) = slot.borrow_mut().take() {
            background_app::uninhibit_idle_session(handle);
        }
    });
    if let Some(theater) = app.get_webview_window("theater") {
        let _ = theater.hide();
    }
    show_main_window(&app);
    Ok(())
}
