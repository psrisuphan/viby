Rust interface for Apple's C language extension of blocks.

This vendored copy is based on block 0.1.6. The only source change is making
the opaque Objective-C runtime class type inhabited so current Rust releases
do not reject its extern static declaration.
