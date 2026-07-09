import Speech
import Foundation

// ── Apple Speech Recognition CLI ──────────────────────────
// Uses the same SFSpeechRecognizer engine as Onit / Cloudless Voice.
// Takes a 16kHz mono WAV file, outputs transcribed text to stdout.
//
// Usage: speech-recognizer <wav-file-path> [language-code]
//   e.g. speech-recognizer /tmp/audio.wav
//   e.g. speech-recognizer /tmp/audio.wav en-US

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: speech-recognizer <wav-file> [language]\n", stderr)
    exit(1)
}

let audioPath = args[1]
let localeCode = args.count >= 3 ? args[2] : "en-US"

let audioURL = URL(fileURLWithPath: audioPath)

// Verify file exists and is readable
guard FileManager.default.isReadableFile(atPath: audioPath) else {
    fputs("Error: cannot read \(audioPath)\n", stderr)
    exit(1)
}

let locale = Locale(identifier: localeCode)
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    fputs("Error: speech recognizer not available for locale \(localeCode)\n", stderr)
    exit(1)
}

// We use on-device recognition — no network, same quality as Onit.
recognizer.defaultTaskHint = .dictation
if #available(macOS 13, *) {
    recognizer.supportsOnDeviceRecognition = true
}

let semaphore = DispatchSemaphore(value: 0)
var resultText = ""
var hadError = false

SFSpeechRecognizer.requestAuthorization { authStatus in
    guard authStatus == .authorized else {
        fputs("Error: speech recognition not authorized (\(authStatus.rawValue))\n", stderr)
        hadError = true
        semaphore.signal()
        return
    }

    let request = SFSpeechURLRecognitionRequest(url: audioURL)
    request.shouldReportPartialResults = false
    request.requiresOnDeviceRecognition = true

    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            fputs("Error: \(error.localizedDescription)\n", stderr)
            hadError = true
            semaphore.signal()
            return
        }
        if let result = result, result.isFinal {
            resultText = result.bestTranscription.formattedString
            semaphore.signal()
        }
    }
}

semaphore.wait()

if hadError { exit(1) }

// Pick the most confident transcription across segments
if resultText.isEmpty {
    fputs("(no speech detected)\n", stderr)
    exit(0)
}

print(resultText)
