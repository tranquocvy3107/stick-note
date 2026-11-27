// Stick Note launcher for Windows.
//
// Why a separate program: Stick Note runs on Node.js, and node.exe is a console program. Starting it
// directly flashes a black window, and a shortcut to it would carry the Node.js name and icon. This
// tiny program is a plain Windows GUI program (no console), carries the Stick Note icon and starts the
// bundled server hidden.
//
// It is compiled with the C# compiler that ships with Windows (csc.exe, C# 5), see
// tools/package/build-windows.mjs, so keep the language features to that level.
//
// Expected layout next to this program:
//   runtime\stick-note-server.exe    the official Node.js node.exe, renamed
//   app\server.js                    the application
//
// It runs:  runtime\stick-note-server.exe app\server.js --open <your arguments>
// "--open" starts the background server when none is running, opens the app window and exits.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    // "--open" normally finishes in about a second. After this long we stop waiting and leave it alone.
    private const int StartTimeoutMs = 30000;

    private const uint MB_ICONERROR = 0x10;
    private const uint MB_SETFOREGROUND = 0x10000;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "MessageBoxW")]
    private static extern int MessageBox(IntPtr window, string text, string caption, uint type);

    private static int Main(string[] args)
    {
        string home = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
        string runtime = Path.Combine(home, @"runtime\stick-note-server.exe");
        string script = Path.Combine(home, @"app\server.js");

        if (!File.Exists(runtime) || !File.Exists(script))
        {
            ShowError("Some files of Stick Note are missing:\n\n" + (File.Exists(runtime) ? script : runtime) +
                      "\n\nPlease install Stick Note again. Your notes are not affected.");
            return 2;
        }

        StringBuilder arguments = new StringBuilder();
        arguments.Append(Quote(script)).Append(" --open");
        foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));

        ProcessStartInfo info = new ProcessStartInfo(runtime, arguments.ToString());
        info.WorkingDirectory = home;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardError = true;
        info.StandardErrorEncoding = Encoding.UTF8;

        try
        {
            StringBuilder errors = new StringBuilder();
            using (Process process = new Process())
            {
                process.StartInfo = info;
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null) lock (errors) { errors.AppendLine(e.Data); }
                };
                process.Start();
                process.BeginErrorReadLine();

                if (!process.WaitForExit(StartTimeoutMs)) return 0;
                if (process.ExitCode == 0) return 0;

                // Do not wait for the error pipe to close: the background server that "--open" started
                // may have inherited it and keeps running. A short pause is enough for the last lines.
                Thread.Sleep(300);
                string details;
                lock (errors) { details = errors.ToString().Trim(); }
                ShowError("Stick Note could not start (code " + process.ExitCode + ")." +
                          (details.Length > 0 ? "\n\n" + details : "") +
                          "\n\nAnother program may be using the same network port, or the files of Stick Note may be damaged." +
                          " Please try again; if it keeps failing, install Stick Note again. Your notes are not affected.");
                return 1;
            }
        }
        catch (Exception ex)
        {
            ShowError("Stick Note could not start.\n\n" + ex.Message +
                      "\n\nSecurity software may have blocked it. Your notes are not affected.");
            return 1;
        }
    }

    private static void ShowError(string text)
    {
        MessageBox(IntPtr.Zero, text, "Stick Note", MB_ICONERROR | MB_SETFOREGROUND);
    }

    // Quote one argument the way Windows programs (and Node.js) parse a command line:
    // wrap it in double quotes when needed, and double the backslashes that precede a quote.
    private static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        StringBuilder sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1).Append('"');
            }
            else
            {
                sb.Append('\\', backslashes).Append(c);
            }
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2).Append('"');
        return sb.ToString();
    }
}
