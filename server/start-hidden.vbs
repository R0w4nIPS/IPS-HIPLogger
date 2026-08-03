Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Logger\server"
WshShell.Run "cmd /c node index.js >> C:\Logger\server\logger.log 2>&1", 0, False
