use viby_lib::utils::{
    OptionalInitialization, recover_optional_initialization, recover_opus_decode_result,
};

fn main() {
    assert!(cfg!(panic = "unwind"), "probe must run with panic=unwind");

    assert_eq!(
        recover_opus_decode_result(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> Result<usize, ()> { panic!("injected Opus decoder panic") },
        ))),
        0,
        "decoder panic must fall back to a silent packet"
    );
    assert_eq!(
        recover_opus_decode_result(std::panic::catch_unwind(|| Ok::<usize, ()>(32))),
        32
    );

    let media_controls = recover_optional_initialization(|| -> Result<(), &'static str> {
        panic!("injected media-controls initialization panic")
    });
    assert!(matches!(media_controls, OptionalInitialization::Panicked));
    assert!(matches!(
        recover_optional_initialization(|| Ok::<usize, &'static str>(7)),
        OptionalInitialization::Ready(7)
    ));

    println!(
        "panic_recovery_probe: panic=unwind; Opus panic -> silent packet; media-controls panic -> unavailable; subsequent work continued"
    );
}
