// Window discovery is in Quartz. A ScreenCaptureKit helper streams one window into a shared BGRA
// buffer, so reading a strip never waits for WindowServer or copies the rest of the frame.
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, fstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { app, screen } from 'electron'
import koffi from 'koffi'
import type { Rect } from '../shared/window'
import { contentTop, FOREVER_PROGRAM, inContent, windowRecord, type WindowRecord } from './capture-darwin-frame'

const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
const proc = koffi.load('/usr/lib/libproc.dylib')
const libc = koffi.load('/usr/lib/libSystem.B.dylib')
const CGRect = koffi.struct('CGRect', { x: 'double', y: 'double', width: 'double', height: 'double' })
const listWindows = cg.func('void * CGWindowListCopyWindowInfo(uint32_t options, uint32_t id)')
const rectFrom = cg.func('CGRectMakeWithDictionaryRepresentation', 'bool', ['void *', koffi.out(koffi.pointer(CGRect))])
const preflight = cg.func('bool CGPreflightScreenCaptureAccess()')
const arrayCount = cf.func('long CFArrayGetCount(void *array)')
const arrayValue = cf.func('void * CFArrayGetValueAtIndex(void *array, long index)')
const dictValue = cf.func('void * CFDictionaryGetValue(void *dict, void *key)')
const numberValue = cf.func('bool CFNumberGetValue(void *number, long type, _Out_ int64_t *out)')
const boolValue = cf.func('bool CFBooleanGetValue(void *value)')
const stringSize = cf.func('long CFStringGetLength(void *string)')
const stringRead = cf.func('bool CFStringGetCString(void *string, void *buffer, long length, uint32_t encoding)')
const release = cf.func('void CFRelease(void *object)')
const pidPath = proc.func('int proc_pidpath(int pid, void *buffer, uint32_t length)')
const map = libc.func('void * mmap(void *address, size_t length, int protection, int flags, int fd, int64_t offset)')
const unmap = libc.func('int munmap(void *address, size_t length)')
const flock = libc.func('int flock(int fd, int operation)')

const EXCLUDE_DESKTOP = 1 << 4, INCLUDING_WINDOW = 1 << 3
const SHARED = 1, NONBLOCKING = 4, UNLOCK = 8
const UTF8 = 0x08000100
const key = (name: string): bigint => koffi.decode(cg.symbol(name), 'void *')
const keys = {
  id: key('kCGWindowNumber'), pid: key('kCGWindowOwnerPID'), bounds: key('kCGWindowBounds'),
  layer: key('kCGWindowLayer'), onScreen: key('kCGWindowIsOnscreen'), title: key('kCGWindowName'),
}

export type WindowHandle = number

function windows(id?: WindowHandle): WindowRecord[] {
  const list = listWindows(id === undefined ? EXCLUDE_DESKTOP : INCLUDING_WINDOW, id ?? 0)
  if (!list) return []
  const windows: WindowRecord[] = []
  try {
    for (let i = 0, count = arrayCount(list); i < count; i++) {
      const dict = arrayValue(list, i)
      const number = (key: bigint): number | null => {
        const value = dictValue(dict, key), out = [0]
        return value && numberValue(value, 4, out) ? Number(out[0]) : null // kCFNumberSInt64Type
      }
      const value = dictValue(dict, keys.bounds), bounds = {} as Rect
      const shown = dictValue(dict, keys.onScreen), name = dictValue(dict, keys.title)
      const title = name && Buffer.alloc(stringSize(name) * 3 + 1)
      const window = windowRecord({
        id: number(keys.id), pid: number(keys.pid), layer: number(keys.layer),
        bounds: value && rectFrom(value, bounds) ? bounds : null,
        onScreen: !!shown && boolValue(shown),
        title: title && stringRead(name, title, title.length, UTF8) ? title.toString('utf8', 0, title.indexOf(0)) : null,
      })
      if (window) windows.push(window)
    }
  } finally {
    release(list)
  }
  return windows
}

export const findWindow = (title: string): WindowHandle | null => windows().find((window) => window.title === title)?.id ?? null

function executable(pid: number): string | null {
  const name = Buffer.alloc(4096) // PROC_PIDPATHINFO_MAXSIZE
  return pidPath(pid, name, name.length) > 0 ? name.toString('utf8', 0, name.indexOf(0)) : null
}

export function programOf(id: WindowHandle): string | null {
  const window = windows(id)[0]
  return window ? executable(window.pid) : null
}

function windowOf(matches: (path: string) => boolean, includeMinimized = false): WindowHandle | null {
  const paths = new Map<number, string | null>()
  let minimized: WindowHandle | null = null
  for (const window of windows()) {
    if (window.layer !== 0 || (!window.onScreen && !includeMinimized)) continue
    if (!paths.has(window.pid)) paths.set(window.pid, executable(window.pid))
    const path = paths.get(window.pid)
    if (!path || !matches(path)) continue
    if (window.onScreen) return window.id
    minimized ??= window.id
  }
  return minimized
}

export const findWindowOf = (program: RegExp): WindowHandle | null => windowOf((path) => program.test(path))

export function findGameWindow(): WindowHandle | null {
  const test = !app.isPackaged && process.env.TWINMAP_CAPTURE_TEST_PROGRAM
  return windowOf(test ? (path) => path === test : (path) => FOREVER_PROGRAM.test(path), true)
}

export const captureAllowed = (): boolean => preflight()

// Quartz calls are shared by windowState, readRow and the occasional rectangle. Recheck often
// enough to notice a resize or display change, without querying WindowServer every 15 ms.
let checked: { id: WindowHandle; until: number; window?: WindowRecord; geometry?: string } | undefined
function windowInfo(id: WindowHandle): WindowRecord | undefined {
  const now = performance.now()
  if (checked?.id === id && checked.until > now) return checked.window
  const window = windows(id)[0]
  const display = window?.onScreen ? screen.getDisplayMatching(window.bounds) : undefined
  const geometry = window && display
    ? `${window.pid}:${window.bounds.width}:${window.bounds.height}:${display.id}:${display.scaleFactor}`
    : undefined
  checked = { id, until: now + 100, window, geometry }
  return window
}

export function windowState(id: WindowHandle): 'gone' | 'minimized' | 'open' {
  const window = windowInfo(id)
  if (!window?.onScreen && active?.id === id) stopCapture()
  return !window ? 'gone' : window.onScreen ? 'open' : 'minimized'
}

type Layout = { width: number; height: number; scale: number; titleBar: number }
type Frame = Layout & { address: bigint; pixels: Buffer; top: number; confirmed: boolean; nextScan: number }
type Capture = { id: WindowHandle; geometry: string; child: ChildProcess; fd: number; path: string; dir: string; frame?: Frame; deadline: number }

let active: Capture | undefined
let retryAt = 0
let lastProblem = ''

function problem(message: string): void {
  if (lastProblem === message) return
  lastProblem = message
  console.error(`Twinmap capture: ${message}`)
}

function forgetFile(path: string, dir: string): void {
  // Once both processes have opened the file, only their descriptors keep it alive.
  try { unlinkSync(path) } catch {}
  try { rmdirSync(dir) } catch {}
}

function retryCapture(): void {
  stopCapture()
  retryAt = performance.now() + 3000
}

export function stopCapture(): void {
  const current = active
  if (!current) return
  active = undefined
  current.child.stdin?.end()
  if (current.frame) unmap(current.frame.address, current.frame.pixels.length)
  closeSync(current.fd)
  forgetFile(current.path, current.dir)
}

function startCapture(id: WindowHandle, geometry: string): Capture | undefined {
  const helper = app.isPackaged ? join(process.resourcesPath, '..', 'Helpers', 'twinmap-capture') : resolve('dist-native/twinmap-capture')
  let dir: string | undefined, fd: number | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'twinmap-capture-'))
    const path = join(dir, 'frame')
    fd = openSync(path, 'wx+', 0o600)
    const child = spawn(helper, [String(id), path], { stdio: ['pipe', 'pipe', 'pipe'] })
    const capture: Capture = { id, geometry, child, fd, path, dir, deadline: performance.now() + 5000 }
    child.stdin.on('error', () => {}) // the helper can reject a window before we close its pipe
    child.once('error', (error) => problem(error.message))
    child.once('close', () => {
      if (active !== capture) return
      retryCapture()
    })
    createInterface({ input: child.stderr }).on('line', problem)
    createInterface({ input: child.stdout }).once('line', (line) => {
      if (active !== capture) return
      forgetFile(path, capture.dir)
      try {
        const { width, height, scale, titleBar } = JSON.parse(line) as Layout
        const length = width * height * 4
        if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
          || !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(titleBar) || titleBar < 0
          || !Number.isSafeInteger(length) || fstatSync(capture.fd).size !== length) {
          throw new Error('invalid shared frame layout')
        }
        const address = map(null, length, 1, 1, capture.fd, 0) as bigint | null // PROT_READ, MAP_SHARED
        if (!address || address === 0xffff_ffff_ffff_ffffn) throw new Error('could not map the shared frame')
        capture.frame = { width, height, scale, titleBar, address, pixels: Buffer.from(koffi.view(address, length)), top: 0, confirmed: false, nextScan: 0 }
      } catch (error) {
        problem(error instanceof Error ? error.message : String(error))
        retryCapture()
      }
    })
    return capture
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (dir) forgetFile(join(dir, 'frame'), dir)
    problem(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

function frameRow(frame: Frame, y: number): Buffer {
  return frame.pixels.subarray(y * frame.width * 4, (y + 1) * frame.width * 4)
}

function withFrame<T>(id: WindowHandle, read: (frame: Frame, bounds: Rect) => T): T | null {
  const window = windowInfo(id)
  if (!window?.onScreen) {
    if (active?.id === id) stopCapture()
    return null
  }
  const { bounds } = window, now = performance.now(), geometry = checked?.geometry
  if (!geometry) return null
  if (active && (active.id !== id || active.geometry !== geometry)) stopCapture()
  if (active && !active.frame && now >= active.deadline) {
    problem('ScreenCaptureKit did not deliver a frame within 5 seconds')
    retryCapture()
  }
  if (!active && now >= retryAt) {
    if (captureAllowed()) active = startCapture(id, geometry)
    if (!active) retryAt = now + 3000
  }
  const frame = active?.frame
  if (!active || !frame || flock(active.fd, SHARED | NONBLOCKING) !== 0) return null
  try {
    if (!frame.confirmed && now >= frame.nextScan) {
      const offset = contentTop(frame, (y) => frameRow(frame, y))
      frame.top = offset.top
      frame.confirmed = offset.confirmed
      frame.nextScan = now + 150
    }
    return read(frame, bounds)
  } finally {
    flock(active.fd, UNLOCK)
  }
}

/** A target-window stream only contains that window, even under other windows. For own/showsOnly
 * it is enough to require an on-screen window and a rectangle within the cached content. */
export function readRect(id: WindowHandle, x: number, y: number, width: number, height: number, _own = false): { width: number; height: number; rgb: Uint8Array; at: { x: number; y: number } } | null {
  return withFrame(id, (frame, bounds) => {
    if (!inContent(frame, x, y, width, height)) return null
    const rgb = new Uint8Array(width * height * 3)
    for (let dy = 0, dst = 0; dy < height; dy++) {
      const row = frameRow(frame, frame.top + y + dy)
      for (let dx = 0, src = x * 4; dx < width; dx++, src += 4) {
        rgb[dst++] = row[src + 2]!
        rgb[dst++] = row[src + 1]!
        rgb[dst++] = row[src]!
      }
    }
    return { width, height, rgb, at: { x: Math.round(bounds.x * frame.scale) + x, y: Math.round(bounds.y * frame.scale) + frame.top + y } }
  })
}

export function readBox(id: WindowHandle, x: number, y: number, size: number): { size: number; rgb: Uint8Array } | null {
  const rectangle = readRect(id, x, y, size, size)
  return rectangle && { size, rgb: rectangle.rgb }
}

export const showsOnly = (id: WindowHandle, x: number, y: number, size: number): boolean =>
  withFrame(id, (frame) => inContent(frame, x, y, size, size)) ?? false

export const readRow = (id: WindowHandle, edge: 'top' | 'bottom' = 'top'): Buffer | null =>
  withFrame(id, (frame) => Buffer.from(frameRow(frame, edge === 'top' ? frame.top : frame.height - 1)))
