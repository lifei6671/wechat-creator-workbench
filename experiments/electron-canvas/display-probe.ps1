param([long]$WindowHandle, [double]$ClientX, [double]$ClientY, [double]$PixelScale,
  [ValidateSet('sample','wheel','click')][string]$Action, [int]$DurationMs = 11000)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class DisplayProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Data { [FieldOffset(0)] public Mouse mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Data data; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr w, ref Point p);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr w);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr w, IntPtr dc);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, IntPtr process);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr w);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  public static object Run(IntPtr w, double x, double y, double scale, string action, int duration) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    uint current=GetCurrentThreadId(), foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
    if(current!=foreground) AttachThreadInput(current,foreground,true);
    try { BringWindowToTop(w); SetForegroundWindow(w); }
    finally { if(current!=foreground) AttachThreadInput(current,foreground,false); }
    var point=new Point {X=(int)Math.Round(x*scale),Y=(int)Math.Round(y*scale)};
    ClientToScreen(w, ref point);
    if(action!="sample") {
      if(GetForegroundWindow()!=w) throw new Exception("Prototype is not in the foreground");
      SetCursorPos(point.X,point.Y);
      Thread.Sleep(100);
      Input[] inputs=action=="wheel"
        ? new[]{new Input {data=new Data {mouse=new Mouse {flags=0x0800,data=unchecked((uint)-120)}}}}
        : new[]{new Input {data=new Data {mouse=new Mouse {flags=0x0002}}},new Input {data=new Data {mouse=new Mouse {flags=0x0004}}}};
      if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf<Input>())!=inputs.Length) throw new Exception("Windows rejected input");
      return true;
    }
    var dc=GetDC(IntPtr.Zero); var samples=new List<object>(); var timer=Stopwatch.StartNew();
    Console.WriteLine("READY"); Console.Out.Flush();
    try {
      while(timer.ElapsedMilliseconds<duration) {
        uint color=GetPixel(dc,point.X,point.Y);
        samples.Add(new {ms=timer.ElapsedMilliseconds,active=GetForegroundWindow()==w,r=color&255,g=(color>>8)&255,b=(color>>16)&255});
        Thread.Sleep(8);
      }
    } finally { ReleaseDC(IntPtr.Zero,dc); }
    return samples;
  }
}
"@
ConvertTo-Json -InputObject ([DisplayProbe]::Run([IntPtr]$WindowHandle,$ClientX,$ClientY,$PixelScale,$Action,$DurationMs)) -Compress
