package main

// ptr is the pointer-to-string helper the backup fixtures need.  The
// columns being backed up are all nullable, so every fixture row has to
// be able to say "this was NULL" as well as "this held a value".
func ptr(s string) *string { return &s }
