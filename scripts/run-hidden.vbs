' Launches the command given in the arguments with no console window,
' waits for it, and propagates its exit code. The scheduled task runs
' node through this wrapper because a bare console app in an interactive
' task pops up a window that looks like a terminal - and closing that
' window kills the supervisor (exit 0xC000013A).
Set shell = CreateObject("WScript.Shell")
cmd = ""
For Each arg In WScript.Arguments
  cmd = cmd & """" & arg & """ "
Next
WScript.Quit shell.Run(Trim(cmd), 0, True)
