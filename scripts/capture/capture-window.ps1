# Capture the running Francois window to PNG frames — the README screenshot/GIF.
#
# Uses PrintWindow with PW_RENDERFULLCONTENT (0x2), which is the only reliable
# way to grab a WebView2 window on Windows: it is GPU-composited, so a plain
# BitBlt / gdigrab of the desktop yields black frames whenever the window is
# occluded, and a desktop grab would also capture whatever is on top of it.
#
# The C# below is pure P/Invoke and returns a raw HBITMAP — deliberately no
# System.Drawing types cross the boundary, because .NET 10 forwards those to
# private assemblies that Add-Type cannot resolve. PowerShell turns the handle
# into a Bitmap with Image::FromHbitmap, where System.Drawing is already loaded.
#
# The raw PrintWindow bitmap is the FULL window rect, which on Windows 11
# includes the invisible resize border. We crop to DWM's extended frame bounds
# so the output is exactly what the user sees — no transparent margin.
#
# Usage:
#   ./capture-window.ps1 -Title 'Francois Dev' -Out shot.png
#   ./capture-window.ps1 -Title 'Francois Dev' -OutDir frames -Frames 200 -Fps 12 -Script @('36:d','72:d')

[CmdletBinding()]
param(
  [string]$Title = 'Francois Dev',
  [string]$Out = '',
  [string]$OutDir = '',
  [int]$Frames = 1,
  [int]$Fps = 12,
  # Actions to fire during a capture run, one per entry, pipe-separated:
  #   '<frame>|key|<SendKeys>'   e.g. '48|key|^k'  (Ctrl+K), '96|key|{ESC}'
  #   '<frame>|click|<x>,<y>'    client coordinates, i.e. the same pixel
  #                              coordinates as the captured frames
  # Clicks are preferred over single-letter shortcuts for anything that must
  # work regardless of where keyboard focus currently sits (the composer
  # textarea and the xterm terminal both swallow the app's letter shortcuts).
  [string[]]$Script = @()
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WinCap {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT r, int size);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);

  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;

  /// Click at a point given in captured-frame (visible client) coordinates.
  public static void ClickAt(IntPtr hwnd, int x, int y) {
    RECT f;
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out f, Marshal.SizeOf(typeof(RECT))) != 0) return;
    SetCursorPos(f.Left + x, f.Top + y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
  }

  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const uint PW_RENDERFULLCONTENT = 0x2;

  /// Grabs the window into a new HBITMAP. Caller owns it (DeleteObject).
  /// Returns IntPtr.Zero on failure. Out params report the full window size.
  public static IntPtr Grab(IntPtr hwnd, out int width, out int height) {
    width = 0; height = 0;
    RECT w;
    if (!GetWindowRect(hwnd, out w)) return IntPtr.Zero;
    width = w.Right - w.Left; height = w.Bottom - w.Top;
    if (width <= 0 || height <= 0) return IntPtr.Zero;

    IntPtr srcDc = GetWindowDC(hwnd);
    IntPtr memDc = CreateCompatibleDC(srcDc);
    IntPtr bmp = CreateCompatibleBitmap(srcDc, width, height);
    IntPtr old = SelectObject(memDc, bmp);

    bool ok = PrintWindow(hwnd, memDc, PW_RENDERFULLCONTENT);

    SelectObject(memDc, old);
    DeleteDC(memDc);
    ReleaseDC(hwnd, srcDc);

    if (!ok) { DeleteObject(bmp); return IntPtr.Zero; }
    return bmp;
  }

  /// Offset + size of the visible frame inside the full window rect.
  public static bool VisibleFrame(IntPtr hwnd, out int dx, out int dy, out int cw, out int ch) {
    dx = 0; dy = 0; cw = 0; ch = 0;
    RECT w, f;
    if (!GetWindowRect(hwnd, out w)) return false;
    if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out f, Marshal.SizeOf(typeof(RECT))) != 0) return false;
    dx = f.Left - w.Left; dy = f.Top - w.Top;
    cw = f.Right - f.Left; ch = f.Bottom - f.Top;
    return dx >= 0 && dy >= 0 && cw > 0 && ch > 0;
  }
}
'@

function Get-TargetWindow([string]$title) {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -eq $title } | Select-Object -First 1
  if (-not $p) {
    $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
  }
  if (-not $p) { throw "No window titled '$title'. Is the app running?" }
  return $p.MainWindowHandle
}

function Save-WindowFrame([IntPtr]$hwnd, [string]$path) {
  $w = 0; $h = 0
  $hbmp = [WinCap]::Grab($hwnd, [ref]$w, [ref]$h)
  if ($hbmp -eq [IntPtr]::Zero) { return $false }
  try {
    $bmp = [System.Drawing.Image]::FromHbitmap($hbmp)
    try {
      $dx = 0; $dy = 0; $cw = 0; $ch = 0
      if ([WinCap]::VisibleFrame($hwnd, [ref]$dx, [ref]$dy, [ref]$cw, [ref]$ch) -and
          ($dx + $cw) -le $w -and ($dy + $ch) -le $h) {
        $rect = New-Object System.Drawing.Rectangle $dx, $dy, $cw, $ch
        $crop = $bmp.Clone($rect, $bmp.PixelFormat)
        try { $crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $crop.Dispose() }
      } else {
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      }
    } finally { $bmp.Dispose() }
  } finally { [void][WinCap]::DeleteObject($hbmp) }
  return $true
}

$hwnd = Get-TargetWindow $Title
[void][WinCap]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500

# Parse the action script into frame -> @(type, payload)
$cues = @{}
foreach ($entry in $Script) {
  $parts = $entry -split '\|', 3
  if ($parts.Count -lt 3) { throw "Bad -Script entry '$entry' (want '<frame>|key|<keys>' or '<frame>|click|<x>,<y>')." }
  $cues[[int]$parts[0]] = @($parts[1], $parts[2])
}

function Invoke-Cue([IntPtr]$hwnd, $cue) {
  switch ($cue[0]) {
    'key' { [System.Windows.Forms.SendKeys]::SendWait($cue[1]) }
    'click' {
      $xy = $cue[1] -split ','
      [WinCap]::ClickAt($hwnd, [int]$xy[0], [int]$xy[1])
    }
    default { throw "Unknown cue type '$($cue[0])'." }
  }
}

if ($Frames -le 1) {
  if (-not $Out) { throw 'Single-frame capture needs -Out.' }
  $dir = Split-Path -Parent $Out
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (-not (Save-WindowFrame $hwnd $Out)) { throw 'PrintWindow failed.' }
  Write-Output "saved $Out"
  return
}

if (-not $OutDir) { throw 'Multi-frame capture needs -OutDir.' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem -Path $OutDir -Filter '*.png' | Remove-Item -Force
$resolved = (Resolve-Path -LiteralPath $OutDir).Path

$interval = [int](1000 / $Fps)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$saved = 0

for ($i = 0; $i -lt $Frames; $i++) {
  if ($cues.ContainsKey($i)) { Invoke-Cue $hwnd $cues[$i] }
  if (Save-WindowFrame $hwnd (Join-Path $resolved ('f{0:d4}.png' -f $i))) { $saved++ }
  $due = ($i + 1) * $interval
  $lag = $due - $sw.ElapsedMilliseconds
  if ($lag -gt 0) { Start-Sleep -Milliseconds $lag }
}

Write-Output "captured $saved/$Frames frames to $resolved"
