import AppKit
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

private struct Layout: Encodable {
    let width: Int
    let height: Int
    let scale: CGFloat
    let titleBar: CGFloat
}

// Electron reads only the requested pixels from the last complete frame. Separate opens of the
// same file let flock protect the frame across processes. Neither side waits for the other's lock.
private final class Frames: NSObject, SCStreamOutput, SCStreamDelegate {
    private let fd: Int32
    private let pixels: UnsafeMutableRawPointer
    private let layout: Layout
    private var announced = false

    init(path: String, layout: Layout) {
        let bytes = layout.width * layout.height * 4
        fd = open(path, O_RDWR)
        guard fd >= 0, ftruncate(fd, off_t(bytes)) == 0,
            let mapped = mmap(nil, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0),
            mapped != MAP_FAILED else { fail("Could not allocate the shared capture frame (errno \(errno))") }
        self.pixels = mapped
        self.layout = layout
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("ScreenCaptureKit stream stopped: \(error.localizedDescription)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let status = attachments.first?[.status] as? Int,
            status == SCFrameStatus.complete.rawValue || status == SCFrameStatus.started.rawValue,
            let image = sample.imageBuffer,
            CVPixelBufferGetWidth(image) == layout.width,
            CVPixelBufferGetHeight(image) == layout.height,
            CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let source = CVPixelBufferGetBaseAddress(image), flock(fd, LOCK_EX | LOCK_NB) == 0 else { return }
        let stride = CVPixelBufferGetBytesPerRow(image), row = layout.width * 4
        if stride == row {
            memcpy(pixels, source, row * layout.height)
        } else {
            for y in 0..<layout.height { memcpy(pixels + y * row, source + y * stride, row) }
        }
        flock(fd, LOCK_UN)
        // The pipe announces one layout, after pixels exist. It carries no image data.
        if !announced {
            announced = true
            guard var message = try? JSONEncoder().encode(layout) else { fail("Could not encode the capture layout") }
            message.append(10)
            FileHandle.standardOutput.write(message)
        }
    }
}

@main
struct Capture {
    @MainActor
    static func main() async {
        let args = CommandLine.arguments
        guard args.count == 3, let id = CGWindowID(args[1]) else { fail("Expected a window ID and a shared frame path") }
        // EOF also stops the stream when Electron crashes or is terminated.
        DispatchQueue.global().async {
            var byte: UInt8 = 0
            while read(STDIN_FILENO, &byte, 1) > 0 {}
            exit(0)
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { $0.windowID == id }) else {
                fail("ScreenCaptureKit could not find window \(id)")
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(filter.pointPixelScale)
            let width = Int((filter.contentRect.width * scale).rounded())
            let height = Int((filter.contentRect.height * scale).rounded())
            guard width > 0, height > 0 else { fail("ScreenCaptureKit returned an empty window") }
            let fullscreen = content.displays.contains { display in
                let bounds = CGDisplayBounds(display.displayID), frame = window.frame
                return abs(frame.minX - bounds.minX) < 1 && abs(frame.minY - bounds.minY) < 1
                    && abs(frame.width - bounds.width) < 1 && abs(frame.height - bounds.height) < 1
            }
            let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
            let standard = window.frame.height - NSWindow.contentRect(forFrameRect: window.frame, styleMask: style).height
            // The filter may already omit some or all of the chrome. Any strip found by
            // Electron refines this AppKit estimate when the game uses a custom window style.
            let excluded = max(0, window.frame.height - filter.contentRect.height)
            let layout = Layout(width: width, height: height, scale: scale, titleBar: fullscreen ? 0 : max(0, standard - excluded))
            let frames = Frames(path: args[2], layout: layout)

            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.captureResolution = .best
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.colorSpaceName = CGColorSpace.sRGB
            config.ignoreShadowsSingleWindow = true
            config.ignoreGlobalClipSingleWindow = true
            config.shouldBeOpaque = true
            config.showsCursor = false
            config.scalesToFit = false
            config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
            config.queueDepth = 3
            let stream = SCStream(filter: filter, configuration: config, delegate: frames)
            try stream.addStreamOutput(frames, type: .screen, sampleHandlerQueue: DispatchQueue(label: "twinmap.capture.frames"))
            try await stream.startCapture()
            // Keep the stream and its output alive while the parent holds the pipe open.
            while true {
                try await Task.sleep(for: .seconds(3600))
                withExtendedLifetime((stream, frames)) {}
            }
        } catch {
            let reason = error as NSError
            fail("ScreenCaptureKit: \(reason.domain) \(reason.code): \(reason.localizedDescription)")
        }
    }
}
