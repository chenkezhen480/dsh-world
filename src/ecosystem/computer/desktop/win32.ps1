# src/ecosystem/computer/desktop/win32.ps1
# Her hands on the partner's computer, from Windows itself: no driver to install. One request per stdin line,
# {"id":1,"op":"windows","args":{}}, one reply per stdout line, {"id":1,"data":...} or {"id":1,"error":"..."}.
# Input is posted to the window, never sent through the partner's mouse and keyboard, so the pointer and the
# foreground stay theirs. Stdin closing is the only way this process ends.
# With -Pipe it is foreground mode's helper instead: started as administrator, it talks over that pipe (see below).
param([string]$Pipe = '', [string]$Key = '')
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public class DeskWindow { public long hwnd { get; set; } public long owner { get; set; } public uint pid { get; set; } public string exe { get; set; } public string title { get; set; } public bool minimized { get; set; } public int width { get; set; } public int height { get; set; } public string appId { get; set; } }
public class DeskShot { public int width { get; set; } public int height { get; set; } public int clientWidth { get; set; } public int clientHeight { get; set; } public string print { get; set; } public int left { get; set; } public int top { get; set; } }

public static class Desk {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  // The wide version: through PostMessageA a Chinese WM_CHAR is read as ANSI bytes and arrives garbled.
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  static bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l) { return PostMessageW(h, msg, w, l); }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern bool GetKeyboardState(byte[] state);
  [DllImport("user32.dll")] static extern bool SetKeyboardState(byte[] state);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  // Per-monitor aware, so window sizes, screenshots and posted coordinates are all real pixels on a scaled screen.
  static readonly IntPtr PER_MONITOR = new IntPtr(-4);
  public static void Aware() { SetProcessDpiAwarenessContext(PER_MONITOR); SetThreadDpiAwarenessContext(PER_MONITOR); }

  public static long Foreground() { return GetForegroundWindow().ToInt64(); }

  /**
   * Top-level windows a person could look at: visible, not a tool window, not cloaked, titled. Owned ones count: a
   * program's dialogs and panels (WeChat's Moments composer) are owned by its main window.
   */
  public static List<DeskWindow> Windows() {
    Aware();
    var list = new List<DeskWindow>();
    var apps = new Dictionary<uint, string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || (GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var title = new StringBuilder(256);
      GetWindowText(h, title, 256);
      if (title.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string exe = "";
      try { exe = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
      RECT r;
      GetWindowRect(h, out r);
      string app;
      if (!apps.TryGetValue(pid, out app)) apps[pid] = app = AppId(pid);
      list.Add(new DeskWindow { hwnd = h.ToInt64(), owner = GetWindow(h, 4).ToInt64(), pid = pid, exe = exe, title = title.ToString(), minimized = IsIconic(h), width = r.R - r.L, height = r.B - r.T, appId = app });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  /**
   * A Store app's id (`Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`), the one its Start menu entry starts it by, so a
   * window titled in one language is found by a name in another; null for any other program.
   */
  static string AppId(uint pid) {
    var process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return null;
    try { uint length = 256; var id = new StringBuilder(256); return GetApplicationUserModelId(process, ref length, id) == 0 ? id.ToString() : null; }
    finally { CloseHandle(process); }
  }

  static IntPtr Live(long hwnd) {
    var h = new IntPtr(hwnd);
    if (!IsWindow(h)) throw new Exception("window " + hwnd + " is gone");
    return h;
  }

  /**
   * The client area as the window itself draws it, covered or not; a part of it when w > 0. The picture is shrunk to
   * fit `edge` and enlarged at most `grow` times, so a small part can be looked at closely.
   */
  public static DeskShot Shot(long hwnd, string file, int edge, double grow, int x, int y, int w, int h, int[] marks) {
    Aware();
    var window = Live(hwnd);
    RECT c;
    GetClientRect(window, out c);
    if (c.R <= 0 || c.B <= 0) throw new Exception("the window has no client area");
    using (var full = new Bitmap(c.R, c.B, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(full)) {
        var dc = g.GetHdc();
        // PW_CLIENTONLY | PW_RENDERFULLCONTENT: without the second flag GPU-drawn windows come out black.
        bool drawn;
        try { drawn = PrintWindow(window, dc, 3); } finally { g.ReleaseHdc(dc); }
        if (!drawn) {
          uint pid; GetWindowThreadProcessId(window, out pid);
          throw new Exception(Elevated(pid) ? "ELEVATED: the window belongs to a program running as administrator" : "PrintWindow failed");
        }
      }
      return Render(full, file, edge, grow, x, y, w, h, marks, 0, 0);
    }
  }
  /** The whole screen (every monitor), as foreground mode sees it; positions on it are screen positions from left, top. */
  public static DeskShot Screen(string file, int edge, double grow, int x, int y, int w, int h, int[] marks) {
    Aware();
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    using (var full = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(left, top, 0, 0, full.Size);
      return Render(full, file, edge, grow, x, y, w, h, marks, left, top);
    }
  }
  /** A process the helper cannot read the token of runs above it: as administrator, or protected. */
  static bool Elevated(uint pid) {
    var process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return true;
    try { IntPtr token; if (!OpenProcessToken(process, 0x8, out token)) return true; CloseHandle(token); return false; }
    finally { CloseHandle(process); }
  }
  /**
   * A part of `full` (all of it when w is 0), fitted to `edge` and enlarged at most `grow` times, with her last input
   * marked: `marks` is x, y pairs, one for a click, the whole path for a drag or a swipe.
   */
  static DeskShot Render(Bitmap full, string file, int edge, double grow, int x, int y, int w, int h, int[] marks, int left, int top) {
    var whole = new Rectangle(0, 0, full.Width, full.Height);
    var part = w > 0 ? Rectangle.Intersect(new Rectangle(x, y, w, h), whole) : whole;
    if (part.Width <= 0 || part.Height <= 0) throw new Exception("the region is outside the picture");
    double k = Math.Min(grow, (double)edge / Math.Max(part.Width, part.Height));
    int ow = Math.Max(1, (int)Math.Round(part.Width * k)), oh = Math.Max(1, (int)Math.Round(part.Height * k));
    using (var picture = new Bitmap(ow, oh)) {
      using (var g = Graphics.FromImage(picture)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(full, new Rectangle(0, 0, ow, oh), part, GraphicsUnit.Pixel);
      }
      // Printed before the mark: a picture taken after a click always carries one, and "nothing moved" is about the window.
      var print = Print(picture);
      // Where the last input landed, so a miss of a few pixels is seen and corrected rather than repeated. A click is a
      // circle with a cross; a path is a line from a circle where it was pressed to a cross where it was let go, since a
      // drag that starts beside what it should carry fails the same as one that ends in the wrong place.
      if (marks != null && marks.Length >= 2) {
        var points = new PointF[marks.Length / 2];
        for (int i = 0; i < points.Length; i++) points[i] = new PointF((float)((marks[2 * i] - part.X) * k), (float)((marks[2 * i + 1] - part.Y) * k));
        using (var g = Graphics.FromImage(picture))
        using (var pen = new Pen(Color.Red, 3)) {
          g.SmoothingMode = SmoothingMode.AntiAlias;
          if (points.Length > 1) g.DrawLines(pen, points);
          float sx = points[0].X, sy = points[0].Y, ex = points[points.Length - 1].X, ey = points[points.Length - 1].Y;
          g.DrawEllipse(pen, sx - 14, sy - 14, 28, 28);
          g.DrawLine(pen, ex - 22, ey, ex - 6, ey); g.DrawLine(pen, ex + 6, ey, ex + 22, ey);
          g.DrawLine(pen, ex, ey - 22, ex, ey - 6); g.DrawLine(pen, ex, ey + 6, ex, ey + 22);
        }
      }
      // A recording keeps hundreds of frames, which as PNG would run to hundreds of megabytes.
      picture.Save(file, file.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ? ImageFormat.Jpeg : ImageFormat.Png);
      return new DeskShot { width = ow, height = oh, clientWidth = full.Width, clientHeight = full.Height, print = print, left = left, top = top };
    }
  }

  /**
   * The picture shrunk to 16 by 16 greys, as hex: two pictures of the same window compare by it, so "did anything
   * move" is answered without looking at either. File sizes do not answer it: a paused video still differs by a spinner.
   */
  static string Print(Bitmap picture) {
    var text = new StringBuilder(512);
    using (var small = new Bitmap(16, 16)) {
      using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(picture, new Rectangle(0, 0, 16, 16)); }
      for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) { var c = small.GetPixel(x, y); text.Append(((c.R * 30 + c.G * 59 + c.B * 11) / 100).ToString("x2")); }
    }
    return text.ToString();
  }

  /**
   * Frames of a recording side by side, each with its time in the corner, as one picture: a whole stretch of video
   * at the cost of a single image. Every tile takes the first frame's shape.
   */
  public static DeskShot Sheet(string[] files, string[] labels, string file, int columns, int tile) {
    if (files.Length == 0 || labels.Length != files.Length || columns < 1) throw new Exception("no frames to lay out");
    int th, gap = 4;
    using (var first = Image.FromFile(files[0])) th = Math.Max(1, (int)Math.Round((double)tile * first.Height / first.Width));
    int rows = (files.Length + columns - 1) / columns;
    int width = columns * tile + (columns + 1) * gap, height = rows * th + (rows + 1) * gap;
    using (var sheet = new Bitmap(width, height)) {
      using (var g = Graphics.FromImage(sheet))
      using (var font = new Font("Segoe UI", 15, FontStyle.Bold, GraphicsUnit.Pixel)) {
        g.Clear(Color.Black);
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        for (int i = 0; i < files.Length; i++) {
          int x = gap + (i % columns) * (tile + gap), y = gap + (i / columns) * (th + gap);
          using (var frame = Image.FromFile(files[i])) g.DrawImage(frame, new Rectangle(x, y, tile, th));
          var size = g.MeasureString(labels[i], font);
          g.FillRectangle(Brushes.Black, x, y, size.Width + 6, size.Height + 2);
          g.DrawString(labels[i], font, Brushes.Yellow, x + 3, y + 1);
        }
      }
      sheet.Save(file, ImageFormat.Jpeg);
    }
    return new DeskShot { width = width, height = height, clientWidth = width, clientHeight = height };
  }

  /** The innermost child window at a client point of `top`, with the point moved into its client coordinates. */
  static IntPtr Under(IntPtr top, ref POINT point) {
    var at = top;
    for (int depth = 0; depth < 16; depth++) {
      var child = ChildWindowFromPointEx(at, point, 1 | 2 | 4);
      if (child == IntPtr.Zero || child == at) break;
      ClientToScreen(at, ref point);
      ScreenToClient(child, ref point);
      at = child;
    }
    return at;
  }
  static IntPtr Pack(int low, int high) { return new IntPtr(((high & 0xFFFF) << 16) | (low & 0xFFFF)); }
  static uint ThreadOf(IntPtr h) { uint pid; return GetWindowThreadProcessId(h, out pid); }

  /**
   * Posted messages do not change the input state a program reads with GetKeyState: Ctrl, Shift and Alt for a
   * combination, the mouse button for a long press or a drag (WinForms reads the button that way). So the window's
   * input state is shared for the while and those keys set down in it, then put back. The program reads the state when
   * it takes the messages, a moment after they are posted. A program that reads the real mouse and keyboard
   * (GetAsyncKeyState, raw input: most games) still sees nothing held; that takes foreground mode.
   */
  static void HoldingDown(uint thread, int[] keys, Action post) {
    uint me = GetCurrentThreadId();
    bool shared = keys.Length > 0 && thread != 0 && AttachThreadInput(me, thread, true);
    var saved = new byte[256];
    try {
      if (shared) {
        GetKeyboardState(saved);
        var state = (byte[])saved.Clone();
        foreach (var key in keys) state[key] |= 0x80;
        SetKeyboardState(state);
      }
      post();
      if (shared) Thread.Sleep(200);
    } finally {
      if (shared) { SetKeyboardState(saved); AttachThreadInput(me, thread, false); }
    }
  }
  /** The virtual key of a mouse button, as GetKeyState knows it. */
  static int ButtonKey(bool right) { return right ? 0x02 : 0x01; }

  public static void Click(long hwnd, int x, int y, bool right, int count, int hold) {
    Aware();
    var point = new POINT { X = x, Y = y };
    var target = Under(Live(hwnd), ref point);
    var at = Pack(point.X, point.Y);
    uint down = right ? 0x204u : 0x201u, up = right ? 0x205u : 0x202u, twice = right ? 0x206u : 0x203u;
    var button = new IntPtr(right ? 2 : 1);
    PostMessage(target, 0x200, IntPtr.Zero, at);
    // A long press is one press, held: the button stays down until the time is up.
    if (hold > 0) { HoldingDown(ThreadOf(target), new[] { ButtonKey(right) }, delegate { PostMessage(target, down, button, at); Thread.Sleep(hold); PostMessage(target, up, IntPtr.Zero, at); }); return; }
    for (int i = 0; i < count; i++) { PostMessage(target, i == 1 ? twice : down, button, at); PostMessage(target, up, IntPtr.Zero, at); }
  }

  /** How far apart in time the moves of a stroke are: often enough that programs see the pointer travel, not jump. */
  const int StrokeStepMs = 20;
  /** The point `share` of the way along the path through xs, ys, measured by length so the pointer moves at one speed. */
  static void Along(int[] xs, int[] ys, double share, out int x, out int y) {
    double total = 0;
    for (int i = 1; i < xs.Length; i++) total += Math.Sqrt(Math.Pow(xs[i] - xs[i - 1], 2) + Math.Pow(ys[i] - ys[i - 1], 2));
    double left = share * total;
    for (int i = 1; i < xs.Length; i++) {
      double length = Math.Sqrt(Math.Pow(xs[i] - xs[i - 1], 2) + Math.Pow(ys[i] - ys[i - 1], 2));
      if (left <= length || i == xs.Length - 1) {
        double t = length > 0 ? Math.Min(1, left / length) : 1;
        x = (int)Math.Round(xs[i - 1] + (xs[i] - xs[i - 1]) * t); y = (int)Math.Round(ys[i - 1] + (ys[i] - ys[i - 1]) * t);
        return;
      }
      left -= length;
    }
    x = xs[0]; y = ys[0];
  }
  /**
   * Presses at the first point, waits `pause` there (a long press, for a drag that needs one), travels the path in
   * `ms` and lets go at the last point; the button stays down throughout, as each move says. A drag is the path of its
   * two ends. Points are in the window's own pixels.
   */
  public static void Stroke(long hwnd, int[] xs, int[] ys, bool right, int pause, int ms) {
    Aware();
    var start = new POINT { X = xs[0], Y = ys[0] };
    var target = Under(Live(hwnd), ref start);
    // The window under the first point takes the whole stroke, in its own pixels.
    int ox = start.X - xs[0], oy = start.Y - ys[0];
    uint down = right ? 0x204u : 0x201u, up = right ? 0x205u : 0x202u;
    var button = new IntPtr(right ? 2 : 1);
    PostMessage(target, 0x200, IntPtr.Zero, Pack(start.X, start.Y));
    HoldingDown(ThreadOf(target), new[] { ButtonKey(right) }, delegate {
      PostMessage(target, down, button, Pack(start.X, start.Y));
      Thread.Sleep(pause);
      int steps = Math.Max(1, ms / StrokeStepMs);
      for (int i = 1; i <= steps; i++) { int x, y; Along(xs, ys, (double)i / steps, out x, out y); PostMessage(target, 0x200, button, Pack(x + ox, y + oy)); Thread.Sleep(StrokeStepMs); }
      PostMessage(target, up, IntPtr.Zero, Pack(xs[xs.Length - 1] + ox, ys[ys.Length - 1] + oy));
    });
  }

  public static void Scroll(long hwnd, int x, int y, int notchesUp, int notchesRight) {
    Aware();
    var top = Live(hwnd);
    var point = new POINT { X = x, Y = y };
    var target = Under(top, ref point);
    var screen = new POINT { X = x, Y = y };
    ClientToScreen(top, ref screen);
    var at = Pack(screen.X, screen.Y);
    if (notchesUp != 0) PostMessage(target, 0x20A, Pack(0, notchesUp * 120), at);
    if (notchesRight != 0) PostMessage(target, 0x20E, Pack(0, notchesRight * 120), at);
  }

  /** Where that window's own thread keeps the keyboard focus, which it keeps while in the background. */
  static IntPtr Focused(IntPtr top, out uint thread) {
    uint pid;
    thread = GetWindowThreadProcessId(top, out pid);
    var info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(info);
    return GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero ? info.hwndFocus : top;
  }

  public static void Type(long hwnd, string text) {
    uint thread;
    var to = Focused(Live(hwnd), out thread);
    foreach (char c in text) PostMessage(to, 0x102, new IntPtr(c), new IntPtr(1));
  }

  static int Left(int modifier) { return modifier == 0x11 ? 0xA2 : modifier == 0x10 ? 0xA0 : 0xA4; }
  static bool Extended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E; }
  static IntPtr KeyBits(int vk, bool up) {
    long bits = 1 | ((long)MapVirtualKey((uint)vk, 0) << 16);
    if (Extended(vk)) bits |= 1L << 24;
    if (up) bits |= 0xC0000000L;
    return new IntPtr(bits);
  }

  /** A key, with Ctrl, Shift and Alt held for a combination and the key itself held for `hold` milliseconds. */
  public static void Key(long hwnd, int vk, int[] modifiers, int hold) {
    uint thread;
    var to = Focused(Live(hwnd), out thread);
    bool alt = Array.IndexOf(modifiers, 0x12) >= 0;
    uint down = alt ? 0x104u : 0x100u, up = alt ? 0x105u : 0x101u;
    var held = new List<int>();
    // Qt and others ask for the left key (VK_LCONTROL), not only the generic one.
    foreach (var m in modifiers) { held.Add(m); held.Add(Left(m)); }
    if (hold > 0) held.Add(vk);
    HoldingDown(thread, held.ToArray(), delegate {
      foreach (var m in modifiers) PostMessage(to, m == 0x12 ? 0x104u : 0x100u, new IntPtr(m), KeyBits(m, false));
      PostMessage(to, down, new IntPtr(vk), KeyBits(vk, false));
      if (hold > 0) Thread.Sleep(hold);
      PostMessage(to, up, new IntPtr(vk), KeyBits(vk, true));
      for (int i = modifiers.Length - 1; i >= 0; i--) PostMessage(to, modifiers[i] == 0x12 ? 0x105u : 0x101u, new IntPtr(modifiers[i]), KeyBits(modifiers[i], true));
    });
  }

  /** A minimized window back to its place, without activating it: the partner keeps the focus. */
  public static bool Restore(long hwnd) {
    var window = Live(hwnd);
    ShowWindow(window, 4);
    Thread.Sleep(300);
    return !IsIconic(window);
  }

  /** Gives the foreground back to `hwnd`; only the thread that has it may hand it over, so its input is joined first. */
  public static bool Refocus(long hwnd) {
    var to = new IntPtr(hwnd);
    if (hwnd == 0 || !IsWindow(to)) return false;
    var front = GetForegroundWindow();
    if (front == to) return true;
    uint pid;
    uint thread = GetWindowThreadProcessId(front, out pid), me = GetCurrentThreadId();
    bool joined = thread != 0 && AttachThreadInput(me, thread, true);
    // Windows lets only the process that had the last input take the foreground, and a program that just pulled
    // itself in front holds it; a key event with no key (code 0) makes this one that process without typing anything.
    keybd_event(0, 0, 0, UIntPtr.Zero);
    keybd_event(0, 0, 2, UIntPtr.Zero);
    try { SetForegroundWindow(to); } finally { if (joined) AttachThreadInput(me, thread, false); }
    return GetForegroundWindow() == to;
  }

  static void Send(INPUT input) { SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  static void MouseAt(int x, int y) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    var move = new INPUT { type = 0 };
    move.u.mouse = new MOUSEINPUT { dx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1)), dy = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1)), flags = 0x0001 | 0x8000 | 0x4000 };
    Send(move);
  }
  static void MouseButton(uint flags) { var input = new INPUT { type = 0 }; input.u.mouse = new MOUSEINPUT { flags = flags }; Send(input); }
  static void KeyEvent(ushort vk, ushort scan, uint flags) { var input = new INPUT { type = 1 }; input.u.key = new KEYBDINPUT { vk = vk, scan = scan, flags = flags }; Send(input); }
  /** Moves the partner's pointer there and clicks: x, y are screen pixels. */
  public static void RealClick(int x, int y, bool right, int count, int hold) {
    Aware();
    MouseAt(x, y); Thread.Sleep(60);
    if (hold > 0) { MouseButton(right ? 0x0008u : 0x0002u); Thread.Sleep(hold); MouseButton(right ? 0x0010u : 0x0004u); return; }
    for (int i = 0; i < Math.Max(1, count); i++) { MouseButton(right ? 0x0008u : 0x0002u); Thread.Sleep(40); MouseButton(right ? 0x0010u : 0x0004u); Thread.Sleep(60); }
  }
  /** The same stroke with the partner's real pointer; points are screen pixels. */
  public static void RealStroke(int[] xs, int[] ys, bool right, int pause, int ms) {
    Aware();
    MouseAt(xs[0], ys[0]); Thread.Sleep(60);
    MouseButton(right ? 0x0008u : 0x0002u);
    Thread.Sleep(pause);
    int steps = Math.Max(1, ms / StrokeStepMs);
    for (int i = 1; i <= steps; i++) { int x, y; Along(xs, ys, (double)i / steps, out x, out y); MouseAt(x, y); Thread.Sleep(StrokeStepMs); }
    Thread.Sleep(40);
    MouseButton(right ? 0x0010u : 0x0004u);
  }
  /** Types as characters, not keys, so any language goes in as written; a line break is the Enter key. */
  public static void RealType(string text) {
    foreach (var ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { RealKey(0x0D, new int[0], 0); continue; }
      KeyEvent(0, ch, 0x0004); KeyEvent(0, ch, 0x0004 | 0x0002); Thread.Sleep(8);
    }
  }
  /** A key with its scan code too: games read the keyboard by scan code. */
  public static void RealKey(int vk, int[] modifiers, int hold) {
    foreach (var m in modifiers) KeyEvent((ushort)m, (ushort)MapVirtualKey((uint)m, 0), 0);
    KeyEvent((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), 0); Thread.Sleep(hold > 0 ? hold : 60);
    KeyEvent((ushort)vk, (ushort)MapVirtualKey((uint)vk, 0), 0x0002);
    for (int i = modifiers.Length - 1; i >= 0; i--) KeyEvent((ushort)modifiers[i], (ushort)MapVirtualKey((uint)modifiers[i], 0), 0x0002);
  }
  public static void RealScroll(int x, int y, int up, int right) {
    Aware();
    MouseAt(x, y); Thread.Sleep(60);
    if (up != 0) { var input = new INPUT { type = 0 }; input.u.mouse = new MOUSEINPUT { data = (uint)(up * 120), flags = 0x0800 }; Send(input); }
    if (right != 0) { var input = new INPUT { type = 0 }; input.u.mouse = new MOUSEINPUT { data = (uint)(right * 120), flags = 0x1000 }; Send(input); }
  }

  public static long[] Cursor() { POINT p; GetCursorPos(out p); return new long[] { p.X, p.Y }; }

  static AutomationElement Child(AutomationElement under, string className) {
    return under == null ? null : under.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, className));
  }
  /** On the taskbar only notification icons count: a taskbar button such as "WeChat - 1 running window" cannot be invoked. */
  static AutomationElement Icon(AutomationElement area, string name, bool notifyOnly) {
    if (area == null) return null;
    foreach (AutomationElement button in area.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))) {
      if (notifyOnly && button.Current.AutomationId != "NotifyItemIcon") continue;
      var label = (button.Current.Name ?? "").Trim();
      if (label.StartsWith(name, StringComparison.OrdinalIgnoreCase)) return button;
    }
    return null;
  }
  static void Invoke(AutomationElement element) { ((InvokePattern)element.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); }

  /**
   * Clicks a program's notification-area icon through UI Automation, which is how a program closed to the tray is
   * brought back as itself; showing its hidden window from outside leaves one that takes no input. Looks in the
   * visible icons, then in the hidden-icons flyout. Returns "missing", or "opened" once the click is made.
   */
  public static string Tray(string name) {
    var root = AutomationElement.RootElement;
    var bar = Child(root, "Shell_TrayWnd");
    var icon = Icon(bar, name, true);
    if (icon == null) {
      var flyout = Child(root, "TopLevelWindowForOverflowXamlIsland");
      if (flyout == null || flyout.Current.IsOffscreen) {
        // The hidden-icons chevron shares its id with the input indicator, but comes first; its name is localized.
        var chevron = bar == null ? null : bar.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "SystemTrayIcon"));
        if (chevron == null) return "missing";
        Invoke(chevron);
        Thread.Sleep(600);
        flyout = Child(root, "TopLevelWindowForOverflowXamlIsland");
      }
      icon = Icon(flyout, name, false);
    }
    if (icon == null) return "missing";
    Invoke(icon);
    return "opened";
  }
}
'@

[Desk]::Aware()
$utf8 = New-Object System.Text.UTF8Encoding $false
if ($Pipe) {
  # Foreground mode: started as administrator through UAC, which leaves no stdin or stdout shared with DSH, so it
  # dials back to the pipe DSH opened and says the key DSH gave it before anything else. The pipe closing ends it.
  $stream = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::InOut)
  $stream.Connect(15000)
  $reader = New-Object System.IO.StreamReader($stream, $utf8)
  $writer = New-Object System.IO.StreamWriter($stream, $utf8)
  $writer.AutoFlush = $true
  $writer.WriteLine((@{ hello = $Key } | ConvertTo-Json -Compress))
} else {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
  $writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
  $writer.AutoFlush = $true
}

# The notification listener is loaded on first use: a machine without it still gets every other operation.
$listener = $null
$asTask = $null
function Await($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  if (-not $task.Wait(15000)) { throw 'the notification listener did not answer' }
  return $task.Result
}
function Notifications {
  if ($null -eq $script:listener) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $script:listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  }
  $status = "$($script:listener.GetAccessStatus())"
  if ($status -eq 'Unspecified') { $status = "$(Await ($script:listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]))" }
  if ($status -ne 'Allowed') { throw 'notification access denied' }
  $posted = Await ($script:listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
  $list = foreach ($one in $posted) {
    $app = ''; $appId = ''; $texts = @()
    # A sender that has been uninstalled has no AppInfo; a notification without the generic template has no text.
    try { $appId = [string]$one.AppInfo.AppUserModelId; $app = [string]$one.AppInfo.DisplayInfo.DisplayName } catch { }
    try { $binding = $one.Notification.Visual.GetBinding('ToastGeneric'); if ($binding) { $texts = @($binding.GetTextElements() | ForEach-Object { [string]$_.Text }) } } catch { }
    @{ id = [long]$one.Id; app = $app; appId = $appId; at = $one.CreationTime.UtcDateTime.ToString('o'); texts = @($texts) }
  }
  return @{ notifications = @($list) }
}

# What the partner sees while she works: a capsule at the top of the screen and a soft glow around the window she
# is on, and a way to stop her (Esc twice, or the capsule's button). Loaded on first use, like the notification
# listener, so a machine where it cannot be drawn still has every other operation. Its words come from the caller:
# this file has no byte-order mark, and Windows PowerShell would misread any that were written here.
$signLoaded = $false
function Sign($a) {
  if (-not $script:signLoaded) {
    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class Sign {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int W, H; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLEND { public byte Op, Flags, Alpha, Format; }
  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT at, ref SIZE size, IntPtr src, ref POINT from, int key, ref BLEND blend, int flags);

  /**
   * A window drawn from a picture with its own transparency, so edges and shadows are smooth. It never takes the focus
   * and is in neither the taskbar nor Alt+Tab; `Through` lets every click fall to what is under it.
   */
  class Layer : Form {
    public bool Through;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get { var p = base.CreateParams; p.ExStyle |= 0x80000 | 0x08000000 | 0x80 | (Through ? 0x20 : 0); return p; }
    }
    protected override void OnPaint(PaintEventArgs e) { }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    public void Put(Bitmap picture, Point at) {
      IntPtr screen = GetDC(IntPtr.Zero), memory = CreateCompatibleDC(screen), bits = picture.GetHbitmap(Color.FromArgb(0)), old = SelectObject(memory, bits);
      try {
        var size = new SIZE { W = picture.Width, H = picture.Height };
        var source = new POINT(); var where = new POINT { X = at.X, Y = at.Y };
        var blend = new BLEND { Op = 0, Flags = 0, Alpha = 255, Format = 1 };
        UpdateLayeredWindow(Handle, screen, ref where, ref size, memory, ref source, 0, ref blend, 2);
      } finally { SelectObject(memory, old); DeleteObject(bits); DeleteDC(memory); ReleaseDC(IntPtr.Zero, screen); }
    }
  }

  /** The helper's stdout, shared with the request loop: a line is written whole, under this object's lock. */
  public static StreamWriter Out;
  static readonly Color Blue = Color.FromArgb(64, 140, 255);
  static readonly ManualResetEvent ready = new ManualResetEvent(false);
  static Layer capsule, glow;
  static System.Windows.Forms.Timer follow, fade, breathe;
  static HookProc hook;
  static Font strong, quiet;
  static IntPtr target = IntPtr.Zero;
  static bool active;
  static string name = "", hint = "", stopText = "", stoppedText = "";
  /** Where the button is on the capsule, for the click; empty once she has been stopped. */
  static Rectangle button = Rectangle.Empty;
  static Rectangle glowAt = Rectangle.Empty;
  static long lastEscape;
  static double scale = 1, phase;
  static int S(double v) { return (int)Math.Round(v * scale); }

  static void Emit(string line) { var o = Out; if (o == null) return; lock (o) { o.WriteLine(line); o.Flush(); } }

  static GraphicsPath Round(RectangleF r, float radius) {
    var path = new GraphicsPath(); float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
    path.AddArc(r.X, r.Y, d, d, 180, 90); path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure(); return path;
  }
  static SizeF Measure(Graphics g, string text, Font font) { return text.Length == 0 ? SizeF.Empty : g.MeasureString(text, font, PointF.Empty, StringFormat.GenericTypographic); }

  /** The capsule, drawn whole: its width follows the words, so they never run under the button. */
  static void DrawCapsule() {
    int shadow = S(10), height = S(38), pad = S(16), dot = S(8), gap = S(10);
    SizeF nameSize, hintSize, stopSize;
    using (var probe = new Bitmap(1, 1)) using (var g = Graphics.FromImage(probe)) {
      g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      nameSize = Measure(g, active ? name : stoppedText, strong); hintSize = active ? Measure(g, hint, quiet) : SizeF.Empty; stopSize = Measure(g, stopText, quiet);
    }
    int buttonWidth = active ? (int)stopSize.Width + S(24) : 0;
    int inner = pad + dot + gap + (int)Math.Ceiling(nameSize.Width) + (active ? S(12) + (int)Math.Ceiling(hintSize.Width) + S(14) + buttonWidth - S(6) : pad - S(6)) + S(6) + (active ? S(5) : 0);
    int width = inner + shadow * 2, total = height + shadow * 2;
    using (var picture = new Bitmap(width, total, PixelFormat.Format32bppPArgb))
    using (var g = Graphics.FromImage(picture)) {
      g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      var body = new RectangleF(shadow, shadow - S(4), inner, height);
      for (int i = shadow; i > 0; i--) using (var path = Round(new RectangleF(body.X - i, body.Y - i + S(3), body.Width + i * 2, body.Height + i * 2), height / 2f + i))
        using (var soft = new SolidBrush(Color.FromArgb((int)(26 * Math.Pow(1 - (double)i / shadow, 2)), 0, 0, 0))) g.FillPath(soft, path);
      using (var path = Round(body, height / 2f)) {
        using (var fill = new SolidBrush(Color.FromArgb(236, 24, 26, 32))) g.FillPath(fill, path);
        using (var line = new Pen(Color.FromArgb(40, 255, 255, 255), Math.Max(1, S(1)))) g.DrawPath(line, path);
      }
      float cx = body.X + pad + dot / 2f, cy = body.Y + height / 2f;
      if (active) {
        // A slow breath around the dot: something is happening, without anything flashing.
        double b = (Math.Sin(phase) + 1) / 2; float halo = dot / 2f + S(2) + (float)(b * S(4));
        using (var ring = new SolidBrush(Color.FromArgb((int)(70 * (1 - b) + 20), Blue))) g.FillEllipse(ring, cx - halo, cy - halo, halo * 2, halo * 2);
      }
      using (var core = new SolidBrush(active ? Blue : Color.FromArgb(150, 155, 165))) g.FillEllipse(core, cx - dot / 2f, cy - dot / 2f, dot, dot);
      float x = body.X + pad + dot + gap;
      using (var white = new SolidBrush(Color.FromArgb(245, 247, 250))) g.DrawString(active ? name : stoppedText, strong, white, x, cy - nameSize.Height / 2f, StringFormat.GenericTypographic);
      button = Rectangle.Empty;
      if (active) {
        x += nameSize.Width + S(12);
        using (var grey = new SolidBrush(Color.FromArgb(150, 156, 168))) g.DrawString(hint, quiet, grey, x, cy - hintSize.Height / 2f, StringFormat.GenericTypographic);
        var pill = new RectangleF(body.Right - S(5) - buttonWidth, body.Y + S(5), buttonWidth, height - S(10));
        using (var path = Round(pill, pill.Height / 2f)) using (var fill = new SolidBrush(Color.FromArgb(34, 255, 255, 255))) g.FillPath(fill, path);
        using (var white = new SolidBrush(Color.FromArgb(240, 242, 246))) g.DrawString(stopText, quiet, white, pill.X + (pill.Width - stopSize.Width) / 2f, pill.Y + (pill.Height - stopSize.Height) / 2f, StringFormat.GenericTypographic);
        button = Rectangle.Round(pill);
      }
      var screen = Screen.PrimaryScreen.WorkingArea;
      capsule.Put(picture, new Point(screen.Left + (screen.Width - width) / 2, screen.Top + S(6)));
    }
  }
  /** A soft blue glow with rounded corners just around the window; owned by it, so above it and under whatever covers it. */
  static void Follow() {
    RECT r;
    int spread = S(9);
    // No window: foreground mode, where she has the whole screen; the glow runs just inside its edge.
    if (active && target == IntPtr.Zero) {
      var all = Screen.PrimaryScreen.Bounds;
      r = new RECT { L = all.Left + spread, T = all.Top + spread, R = all.Right - spread, B = all.Bottom - spread };
    } else if (!active || !IsWindow(target) || !IsWindowVisible(target) || IsIconic(target) || !GetWindowRect(target, out r)) { if (glow.Visible) glow.Hide(); glowAt = Rectangle.Empty; return; }
    // A maximized window reaches past the screen and under the taskbar; the glow is kept where it can be seen.
    var area = target == IntPtr.Zero ? Screen.PrimaryScreen.Bounds : Screen.FromHandle(target).WorkingArea;
    var bounds = Rectangle.Intersect(new Rectangle(r.L - spread, r.T - spread, r.R - r.L + spread * 2, r.B - r.T + spread * 2), area);
    if (bounds.Width <= spread * 2 || bounds.Height <= spread * 2) { if (glow.Visible) glow.Hide(); glowAt = Rectangle.Empty; return; }
    if (bounds != glowAt) {
      var edge = Rectangle.Intersect(new Rectangle(r.L, r.T, r.R - r.L, r.B - r.T), area);
      using (var picture = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppPArgb))
      using (var g = Graphics.FromImage(picture)) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rim = new RectangleF(edge.X - bounds.X, edge.Y - bounds.Y, edge.Width, edge.Height);
        float radius = S(8);
        for (int i = spread; i >= 1; i--) using (var pen = new Pen(Color.FromArgb((int)(60 * Math.Pow(1 - (double)i / (spread + 1), 2)), Blue), 2))
          using (var path = Round(new RectangleF(rim.X - i, rim.Y - i, rim.Width + i * 2, rim.Height + i * 2), radius + i)) g.DrawPath(pen, path);
        using (var pen = new Pen(Color.FromArgb(230, Blue), Math.Max(2, S(2)))) using (var path = Round(rim, radius)) g.DrawPath(pen, path);
        glow.Put(picture, bounds.Location);
      }
      glowAt = bounds;
    }
    if (!glow.Visible) glow.Show();
    // A full-screen game is often always-on-top too and comes back over the sign each time she clicks into it:
    // while she is on the whole screen, the sign is put back on top, without taking the focus.
    if (target == IntPtr.Zero) { SetWindowPos(glow.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x13); SetWindowPos(capsule.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x13); }
  }
  static void Halt() {
    if (!active) return;
    active = false;
    Follow(); DrawCapsule();
    fade.Stop(); fade.Start();
    Emit("{\"event\":\"stop\"}");
  }
  /** Looks at every key press and passes it on untouched: the partner's own Esc is theirs; only two in half a second stop her. */
  static IntPtr Keys(int code, IntPtr w, IntPtr l) {
    try {
      // LLKHF_INJECTED: a key she sent herself in foreground mode is not the partner asking her to stop.
      if (code >= 0 && active && w.ToInt64() == 0x100 && Marshal.ReadInt32(l) == 27 && (Marshal.ReadInt32(l, 8) & 0x10) == 0) {
        long now = Environment.TickCount;
        if (lastEscape != 0 && now - lastEscape < 500) { lastEscape = 0; capsule.BeginInvoke((MethodInvoker)Halt); } else lastEscape = now;
      }
    } catch { }
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }
  static void Run() {
    try {
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      scale = GetDpiForSystem() / 96.0;
      strong = new Font("Microsoft YaHei UI", (float)(14 * scale), FontStyle.Bold, GraphicsUnit.Pixel);
      quiet = new Font("Microsoft YaHei UI", (float)(12.5 * scale), FontStyle.Regular, GraphicsUnit.Pixel);
      capsule = new Layer { FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual, TopMost = true, ShowInTaskbar = false, Cursor = Cursors.Hand };
      capsule.MouseUp += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left && button.Contains(e.Location)) Halt(); };
      glow = new Layer { Through = true, FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual, ShowInTaskbar = false };
      var made = capsule.Handle; made = glow.Handle;
      // WDA_EXCLUDEFROMCAPTURE: her screenshots of the screen do not show the sign over what she is looking at.
      SetWindowDisplayAffinity(capsule.Handle, 0x11); SetWindowDisplayAffinity(glow.Handle, 0x11);
      follow = new System.Windows.Forms.Timer { Interval = 150 };
      follow.Tick += delegate { try { Follow(); } catch { } };
      breathe = new System.Windows.Forms.Timer { Interval = 50 };
      breathe.Tick += delegate { if (!active) return; phase += 0.12; try { DrawCapsule(); } catch { } };
      fade = new System.Windows.Forms.Timer { Interval = 2500 };
      fade.Tick += delegate { fade.Stop(); if (!active) { capsule.Hide(); follow.Stop(); breathe.Stop(); } };
      hook = Keys;
      SetWindowsHookEx(13, hook, GetModuleHandle(null), 0);
    } finally { ready.Set(); }
    Application.Run();
  }
  static void OnUi(MethodInvoker work) {
    if (capsule == null) {
      var thread = new Thread(Run) { IsBackground = true };
      thread.SetApartmentState(ApartmentState.STA);
      thread.Start();
      ready.WaitOne(10000);
    }
    if (capsule == null || !capsule.IsHandleCreated) throw new Exception("the sign could not be drawn");
    capsule.BeginInvoke(work);
  }

  public static void Show(long hwnd, string who, string help, string stop, string stopped) {
    OnUi(delegate {
      fade.Stop();
      var next = new IntPtr(hwnd);
      if (next != target) { glow.Hide(); glowAt = Rectangle.Empty; target = next; SetWindowLongPtr(glow.Handle, -8, target); }
      // Set every time: the elevated helper's first sign is on the whole screen, which is no change from where it starts.
      glow.TopMost = target == IntPtr.Zero;
      name = who; hint = help; stopText = stop; stoppedText = stopped;
      if (!active) lastEscape = 0;
      active = true;
      DrawCapsule();
      if (!capsule.Visible) capsule.Show();
      follow.Start(); breathe.Start();
      Follow();
    });
  }
  public static void Hide() {
    if (capsule == null) return;
    OnUi(delegate { if (!active) return; active = false; Follow(); capsule.Hide(); follow.Stop(); breathe.Stop(); });
  }
}
'@
    [Sign]::Out = $writer
    $script:signLoaded = $true
  }
  if ($a.show) { [Sign]::Show([long]$a.hwnd, [string]$a.text, [string]$a.hint, [string]$a.stop, [string]$a.stopped) } else { [Sign]::Hide() }
  return @{}
}

# Taskbar buttons that ask for attention, for her inbox: the shell tells a window registered for its hook which window
# flashed, so no picture is looked at. Started on first use, on a thread of its own; `flashes` hands over what came
# since the last call. A program is named by its own description, never by its window title, which can hold a message.
$flashLoaded = $false
function Flashes {
  if (-not $script:flashLoaded) {
    Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class Flash {
  [DllImport("user32.dll")] static extern bool RegisterShellHookWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string name);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public class Seen { public string app { get; set; } public string exe { get; set; } public string at { get; set; } }
  class Ear : NativeWindow {
    readonly uint shell;
    public Ear() { CreateHandle(new CreateParams()); shell = RegisterWindowMessage("SHELLHOOK"); RegisterShellHookWindow(Handle); }
    protected override void WndProc(ref Message m) {
      // A flashing button comes as HSHELL_FLASH on some systems and as HSHELL_REDRAW on others (Windows 11 here), which
      // is also what a new title sends; so a redraw counts only when the window's title is the one it already had.
      if (m.Msg == shell) {
        long code = m.WParam.ToInt64();
        if (code == 0x8006) Heard(m.LParam);
        else if (code == 6) { string was, now = Title(m.LParam); lock (titles) { if (titles.TryGetValue(m.LParam, out was) && was == now) Heard(m.LParam); titles[m.LParam] = now; } }
      }
      base.WndProc(ref m);
    }
  }
  static readonly List<Seen> heard = new List<Seen>();
  static readonly Dictionary<IntPtr, string> titles = new Dictionary<IntPtr, string>();
  static string Title(IntPtr h) { var t = new System.Text.StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
  static readonly ManualResetEvent ready = new ManualResetEvent(false);
  static Thread thread;
  static void Heard(IntPtr window) {
    uint pid; GetWindowThreadProcessId(window, out pid);
    if (pid == (uint)Process.GetCurrentProcess().Id) return;
    string exe = "", app = "";
    try {
      var process = Process.GetProcessById((int)pid);
      exe = process.ProcessName;
      try { app = process.MainModule.FileVersionInfo.FileDescription; } catch { }
    } catch { }
    if (string.IsNullOrWhiteSpace(app)) app = exe;
    lock (heard) { heard.Add(new Seen { app = app.Trim(), exe = exe, at = DateTime.UtcNow.ToString("o") }); if (heard.Count > 200) heard.RemoveAt(0); }
  }
  public static Seen[] Take() {
    if (thread == null) {
      // The titles windows have now, so the first flash of a window already open is told from a new title.
      EnumWindows((h, l) => { if (IsWindowVisible(h)) titles[h] = Title(h); return true; }, IntPtr.Zero);
      thread = new Thread(() => { new Ear(); ready.Set(); Application.Run(); }) { IsBackground = true };
      thread.SetApartmentState(ApartmentState.STA);
      thread.Start();
      if (!ready.WaitOne(10000)) throw new Exception("the taskbar listener did not start");
    }
    lock (heard) { var all = heard.ToArray(); heard.Clear(); return all; }
  }
}
'@
    $script:flashLoaded = $true
  }
  return @{ flashes = @([Flash]::Take()) }
}

function Run($op, $a) {
  switch ($op) {
    'windows' { return @{ windows = @([Desk]::Windows()); foreground = [Desk]::Foreground() } }
    'apps' { return @{ apps = @(Get-StartApps | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } }) } }
    'launch' { Start-Process "shell:AppsFolder\$($a.appId)"; return @{} }
    'shot' { return [Desk]::Shot([long]$a.hwnd, [string]$a.file, [int]$a.edge, [double]$a.grow, [int]$a.x, [int]$a.y, [int]$a.w, [int]$a.h, [int[]]@($a.marks | Where-Object { $null -ne $_ })) }
    'click' { [Desk]::Click([long]$a.hwnd, [int]$a.x, [int]$a.y, [bool]$a.right, [int]$a.count, [int]$a.hold); return @{} }
    'scroll' { [Desk]::Scroll([long]$a.hwnd, [int]$a.x, [int]$a.y, [int]$a.up, [int]$a.right); return @{} }
    'type' { [Desk]::Type([long]$a.hwnd, [string]$a.text); return @{} }
    'key' { [Desk]::Key([long]$a.hwnd, [int]$a.vk, [int[]]@($a.modifiers | Where-Object { $null -ne $_ }), [int]$a.hold); return @{} }
    'restore' { return @{ restored = [Desk]::Restore([long]$a.hwnd) } }
    'refocus' { return @{ refocused = [Desk]::Refocus([long]$a.hwnd) } }
    'tray' { return @{ result = [Desk]::Tray([string]$a.name); cursor = [Desk]::Cursor() } }
    'cursor' { return @{ cursor = [Desk]::Cursor() } }
    'screen' { return [Desk]::Screen([string]$a.file, [int]$a.edge, [double]$a.grow, [int]$a.x, [int]$a.y, [int]$a.w, [int]$a.h, [int[]]@($a.marks | Where-Object { $null -ne $_ })) }
    'stroke' { [Desk]::Stroke([long]$a.hwnd, [int[]]@($a.xs), [int[]]@($a.ys), [bool]$a.right, [int]$a.pause, [int]$a.ms); return @{} }
    'rstroke' { [Desk]::RealStroke([int[]]@($a.xs), [int[]]@($a.ys), [bool]$a.right, [int]$a.pause, [int]$a.ms); return @{} }
    'rclick' { [Desk]::RealClick([int]$a.x, [int]$a.y, [bool]$a.right, [int]$a.count, [int]$a.hold); return @{} }
    'rtype' { [Desk]::RealType([string]$a.text); return @{} }
    'rkey' { [Desk]::RealKey([int]$a.vk, [int[]]@($a.modifiers | Where-Object { $null -ne $_ }), [int]$a.hold); return @{} }
    'rscroll' { [Desk]::RealScroll([int]$a.x, [int]$a.y, [int]$a.up, [int]$a.right); return @{} }
    'sign' { return Sign $a }
    'sheet' { return [Desk]::Sheet([string[]]@($a.files), [string[]]@($a.labels), [string]$a.file, [int]$a.columns, [int]$a.tile) }
    'notifications' { return Notifications }
    'flashes' { return Flashes }
    default { throw "unknown op $op" }
  }
}

while ($null -ne ($line = $reader.ReadLine())) {
  $request = $line | ConvertFrom-Json
  try { $reply = @{ id = $request.id; data = (Run $request.op $request.args) } }
  catch { $reply = @{ id = $request.id; error = $_.Exception.Message } }
  # The sign's own thread writes its events to the same stream, so a line is written whole under one lock.
  $text = $reply | ConvertTo-Json -Compress -Depth 6
  [System.Threading.Monitor]::Enter($writer)
  try { $writer.WriteLine($text) } finally { [System.Threading.Monitor]::Exit($writer) }
}
