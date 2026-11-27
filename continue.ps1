param([int]$StartPid = 0, [int]$ClaudePid = 0, [string]$Text = 'continue', [int]$DelayMs = 2500)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = if ($env:SWAPHAT_HOME) { $env:SWAPHAT_HOME } else { $here }
function Write-SwapLog($m) { Add-Content (Join-Path $appDir 'swap.log') ("{0:s} continue: {1}" -f (Get-Date), $m) }

if (-not $ClaudePid) {
  $procId = $StartPid; $found = 0
  for ($i = 0; $i -lt 12 -and $procId; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $p) { break }
    if ($p.Name -ieq 'claude.exe') { $found = $p.ProcessId; break }
    $procId = $p.ParentProcessId
  }
  if (-not $found) { Write-SwapLog "no claude.exe above pid $StartPid"; exit 1 }
  $safe = $Text -replace '"', ''
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -ClaudePid $found -DelayMs $DelayMs -Text `"$safe`""
  $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = $si }
  Write-SwapLog "claude $found, typer pid $($r.ProcessId) rc $($r.ReturnValue)"
  exit 0
}

if (-not ('Swaphat.ConIn' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Swaphat {
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }
  public static class ConIn {
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    static INPUT_RECORD Key(char c, ushort vk, bool down) {
      var r = new INPUT_RECORD();
      r.EventType = 1; r.bKeyDown = down ? 1 : 0; r.wRepeatCount = 1; r.wVirtualKeyCode = vk; r.UnicodeChar = c;
      return r;
    }
    public static string Type(uint pid, string text) {
      FreeConsole();
      if (!AttachConsole(pid)) return "AttachConsole failed " + Marshal.GetLastWin32Error();
      IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == new IntPtr(-1)) return "CONIN$ failed " + Marshal.GetLastWin32Error();
      var recs = new System.Collections.Generic.List<INPUT_RECORD>();
      foreach (char c in text) { recs.Add(Key(c, 0, true)); recs.Add(Key(c, 0, false)); }
      recs.Add(Key('\r', 0x0D, true)); recs.Add(Key('\r', 0x0D, false));
      uint n; bool ok = WriteConsoleInputW(h, recs.ToArray(), (uint)recs.Count, out n);
      CloseHandle(h); FreeConsole();
      return ok ? ("ok " + n) : ("WriteConsoleInput failed " + Marshal.GetLastWin32Error());
    }
  }
}
"@
}
Start-Sleep -Milliseconds $DelayMs
Write-SwapLog ("typed into claude {0}: {1}" -f $ClaudePid, [Swaphat.ConIn]::Type([uint32]$ClaudePid, $Text))
