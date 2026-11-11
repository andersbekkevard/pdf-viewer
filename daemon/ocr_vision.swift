// On-device text recognition for the reader (daemon/ocr.py).
//
// Usage: pdfv-ocr [--languages nb-NO,en-US] IMAGE...
//        pdfv-ocr --supported
//
// For each image, in order, prints one JSON object on its own line:
//   {"w": px, "h": px, "lines": [{"t": text, "c": confidence,
//     "b": [x, y, w, h], "q": quad, "words": [{"t": word, "b": [x, y, w, h], "q": quad}]}]}
// Boxes are Vision's: normalized to the image, origin at the bottom-left.
// A quad is the text's own corners [tlx, tly, trx, try, brx, bry, blx, bly]:
// top-left to top-right is the direction the text advances, which differs
// from the image's +x for sideways text. A word box is null when Vision
// gives none. An image that cannot be read
// prints {"error": "..."}; the tool still exits 0 and goes on.
//
// The daemon compiles this file once with swiftc into a tool directory keyed
// by the file's hash, and runs it as a child process, so a Vision failure
// costs that process, never the daemon. Images are files the daemon rendered;
// nothing leaves the machine.
import Foundation
import Vision

func box(_ r: CGRect) -> [Double] {
    return [Double(r.origin.x), Double(r.origin.y), Double(r.size.width), Double(r.size.height)]
}

func quad(_ r: VNRectangleObservation) -> [Double] {
    return [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].flatMap { [Double($0.x), Double($0.y)] }
}

func emit(_ object: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: []),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"error\":\"encode\"}")
    }
    fflush(stdout)
}

var languages: [String] = []
var paths: [String] = []
var args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
    let a = args[i]
    if a == "--supported" {
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = .accurate
        emit(["revision": r.revision, "languages": (try? r.supportedRecognitionLanguages()) ?? []])
        exit(0)
    } else if a == "--languages", i + 1 < args.count {
        languages = args[i + 1].split(separator: ",").map(String.init)
        i += 2
        continue
    }
    paths.append(a)
    i += 1
}

for path in paths {
    autoreleasepool {
        let url = URL(fileURLWithPath: path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            emit(["error": "unreadable image"])
            return
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if #available(macOS 13.0, *) {
            request.automaticallyDetectsLanguage = languages.isEmpty
        }
        if !languages.isEmpty {
            request.recognitionLanguages = languages
        }
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            emit(["error": "\(error)"])
            return
        }
        var lines: [[String: Any]] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let text = candidate.string
            var words: [[String: Any]] = []
            var index = text.startIndex
            while index < text.endIndex {
                while index < text.endIndex && text[index].isWhitespace { index = text.index(after: index) }
                if index >= text.endIndex { break }
                var end = index
                while end < text.endIndex && !text[end].isWhitespace { end = text.index(after: end) }
                let range = index..<end
                var word: [String: Any] = ["t": String(text[range])]
                if let rect = try? candidate.boundingBox(for: range) {
                    word["b"] = box(rect.boundingBox)
                    word["q"] = quad(rect)
                } else {
                    word["b"] = NSNull()
                }
                words.append(word)
                index = end
            }
            lines.append(["t": text, "c": Double(candidate.confidence),
                          "b": box(observation.boundingBox), "q": quad(observation), "words": words])
        }
        emit(["w": image.width, "h": image.height, "lines": lines])
    }
}
