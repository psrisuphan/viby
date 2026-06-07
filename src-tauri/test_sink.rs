use rodio::{Sink, OutputStream};
fn main() {
    let (_stream, handle) = OutputStream::try_default().unwrap();
    let sink = Sink::try_new(&handle).unwrap();
    let len: usize = sink.len();
}
