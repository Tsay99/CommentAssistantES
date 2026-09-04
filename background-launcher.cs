using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class BackgroundLauncher
{
    // Built as winexe: the launcher itself never allocates a console.
    private static int Main()
    {
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        string log = Path.Combine(root, "logs", "background-launcher-status.txt");
        try
        {
            string script = Path.Combine(root, "watchdog.ps1");
            if (!File.Exists(script)) return 2;
            var start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File \"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var process = Process.Start(start))
            {
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                Task.WaitAll(output, error);
                Directory.CreateDirectory(Path.GetDirectoryName(log));
                // Never copy child output into logs: only a timestamp and exit status.
                File.WriteAllText(log, DateTime.UtcNow.ToString("o") + " exit=" + process.ExitCode);
                return process.ExitCode;
            }
        }
        catch
        {
            try { File.WriteAllText(log, DateTime.UtcNow.ToString("o") + " launcher-error"); } catch { }
            return 1;
        }
    }
}

