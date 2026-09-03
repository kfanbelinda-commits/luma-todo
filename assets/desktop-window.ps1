param(
    [Parameter(Mandatory = $true)]
    [long] $Handle,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Attach', 'Detach')]
    [string] $Mode
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class LumaDesktopWindow
{
    private const int GWL_STYLE = -16;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_POPUP = 0x80000000L;
    private const uint WM_SPAWN_WORKER = 0x052C;
    private const uint SMTO_NORMAL = 0x0000;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_FRAMECHANGED = 0x0020;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const int SW_RESTORE = 9;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongW")]
    private static extern IntPtr GetWindowLongPtr32(IntPtr hwnd, int index);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongW")]
    private static extern IntPtr SetWindowLongPtr32(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hwnd,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out IntPtr result
    );

    private static IntPtr GetWindowLongPtr(IntPtr hwnd, int index)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, index) : GetWindowLongPtr32(hwnd, index);
    }

    private static void SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, index, value);
        else SetWindowLongPtr32(hwnd, index, value);
    }

    private static IntPtr FindDesktopHost()
    {
        IntPtr progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero)
        {
            IntPtr ignored;
            SendMessageTimeout(progman, WM_SPAWN_WORKER, IntPtr.Zero, IntPtr.Zero, SMTO_NORMAL, 1000, out ignored);
        }

        IntPtr separateWorker = IntPtr.Zero;
        IntPtr iconsHost = IntPtr.Zero;
        EnumWindows(delegate(IntPtr top, IntPtr unused)
        {
            IntPtr defView = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defView == IntPtr.Zero) return true;
            iconsHost = top;
            separateWorker = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
            return separateWorker == IntPtr.Zero;
        }, IntPtr.Zero);

        // Desktop widgets must share the WorkerW that owns SHELLDLL_DefView.
        // The separate WorkerW sits behind the desktop surface and can be
        // covered when Windows activates "Show desktop".
        if (iconsHost != IntPtr.Zero) return iconsHost;
        if (separateWorker != IntPtr.Zero) return separateWorker;
        return progman;
    }

    private static IntPtr EnterPerMonitorDpiMode()
    {
        try { return SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
        catch (EntryPointNotFoundException) { return IntPtr.Zero; }
    }

    private static void RestoreDpiMode(IntPtr previousContext)
    {
        if (previousContext == IntPtr.Zero) return;
        try { SetThreadDpiAwarenessContext(previousContext); }
        catch (EntryPointNotFoundException) { }
    }

    public static int[] Bounds(long rawHandle)
    {
        IntPtr previousDpiContext = EnterPerMonitorDpiMode();
        try { return BoundsCore(rawHandle); }
        finally { RestoreDpiMode(previousDpiContext); }
    }

    private static int[] BoundsCore(long rawHandle)
    {
        IntPtr hwnd = new IntPtr(rawHandle);
        RECT rect;
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out rect)) return new int[0];
        return new int[] { rect.Left, rect.Top, rect.Right, rect.Bottom };
    }

    public static bool Attach(long rawHandle)
    {
        IntPtr previousDpiContext = EnterPerMonitorDpiMode();
        try { return AttachCore(rawHandle); }
        finally { RestoreDpiMode(previousDpiContext); }
    }

    private static bool AttachCore(long rawHandle)
    {
        IntPtr hwnd = new IntPtr(rawHandle);
        IntPtr host = FindDesktopHost();
        if (hwnd == IntPtr.Zero || host == IntPtr.Zero) return false;
        RECT windowRect;
        if (!GetWindowRect(hwnd, out windowRect)) return false;

        POINT hostPoint = new POINT { X = windowRect.Left, Y = windowRect.Top };
        if (!ScreenToClient(host, ref hostPoint)) return false;

        long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
        SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr((style & ~WS_POPUP) | WS_CHILD));
        SetParent(hwnd, host);
        ShowWindow(hwnd, SW_RESTORE);
        SetWindowPos(
            hwnd,
            HWND_TOP,
            hostPoint.X,
            hostPoint.Y,
            windowRect.Right - windowRect.Left,
            windowRect.Bottom - windowRect.Top,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW
        );
        return GetParent(hwnd) == host;
    }

    public static bool Detach(long rawHandle)
    {
        IntPtr previousDpiContext = EnterPerMonitorDpiMode();
        try { return DetachCore(rawHandle); }
        finally { RestoreDpiMode(previousDpiContext); }
    }

    private static bool DetachCore(long rawHandle)
    {
        IntPtr hwnd = new IntPtr(rawHandle);
        RECT windowRect;
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out windowRect)) return false;

        SetParent(hwnd, IntPtr.Zero);
        long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
        SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr((style & ~WS_CHILD) | WS_POPUP));
        SetWindowPos(
            hwnd,
            HWND_TOP,
            windowRect.Left,
            windowRect.Top,
            windowRect.Right - windowRect.Left,
            windowRect.Bottom - windowRect.Top,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW
        );
        return GetParent(hwnd) == IntPtr.Zero;
    }
}
'@

$success = if ($Mode -eq 'Attach') {
    $before = [LumaDesktopWindow]::Bounds($Handle)
    [LumaDesktopWindow]::Attach($Handle)
}
else {
    $before = [LumaDesktopWindow]::Bounds($Handle)
    [LumaDesktopWindow]::Detach($Handle)
}

if (-not $success) {
    throw "Unable to $($Mode.ToLowerInvariant()) the Luma window."
}

$after = [LumaDesktopWindow]::Bounds($Handle)
$boundsPreserved = $before.Count -eq 4 -and $after.Count -eq 4 `
    -and [Math]::Abs($before[0] - $after[0]) -le 1 `
    -and [Math]::Abs($before[1] - $after[1]) -le 1 `
    -and [Math]::Abs($before[2] - $after[2]) -le 1 `
    -and [Math]::Abs($before[3] - $after[3]) -le 1

[pscustomobject]@{
    success = $true
    mode = $Mode
    boundsPreserved = $boundsPreserved
    before = $before
    after = $after
} | ConvertTo-Json -Compress
