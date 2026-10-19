use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(super) fn resolve_launch_paths<T: AsRef<OsStr>>(args: &[T], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .map(|argument| PathBuf::from(argument.as_ref()))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resolve_launch_paths;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    #[test]
    fn skips_argv_zero_and_resolves_relative_and_absolute_paths() {
        let args = vec![
            OsString::from("viby"),
            OsString::from("relative song.flac"),
            OsString::from("/music/absolute.opus"),
        ];

        assert_eq!(
            resolve_launch_paths(&args, Path::new("/home/test")),
            vec![
                PathBuf::from("/home/test/relative song.flac"),
                PathBuf::from("/music/absolute.opus"),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_non_utf8_path_arguments() {
        use std::os::unix::ffi::OsStringExt;

        let filename = OsString::from_vec(vec![b'n', b'o', b'n', b'u', b't', b'f', b'8', 0xff]);
        let args = vec![OsString::from("viby"), filename.clone()];

        assert_eq!(
            resolve_launch_paths(&args, Path::new("/home/test")),
            vec![PathBuf::from("/home/test").join(filename)]
        );
    }
}
