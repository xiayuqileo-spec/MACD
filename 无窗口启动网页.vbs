Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
cmd = """" & root & "\.venv\Scripts\pythonw.exe"" """ & root & "\ai_stock_selector.py"""
shell.Run cmd, 0, False
WScript.Sleep 5000
shell.Run "http://127.0.0.1:5000", 1, False
