import Foundation
import AVFoundation
import AudioToolbox

/// Audio engine iOS — bước 3.4 plan (DAC via AVAudioSession).
///
/// Cách làm (chuẩn iOS, Apple không cho bypass như Android):
/// - Đọc sample rate thật từ file (AVURLAsset → format description)
/// - Set AVAudioSession: category .playback, preferredSampleRate = sample rate file
/// - Volume = 100% (1.0), không EQ, không processing
/// - iOS không resample như Android nên đạt gần bit-perfect khi làm đúng.
@MainActor
class AudioEngine: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTrack: Track? = nil
    @Published private(set) var sampleRate: Double = 0
    /// 4.4: bit depth đo từ header (0 = không đo được, không bịa).
    @Published private(set) var bitDepth: Int = 0
    /// 4.4: nhãn định dạng (FLAC/WAV/MP3...) từ mimeType/tên file.
    @Published private(set) var formatLabel: String = ""
    @Published var errorText: String? = nil

    /// 4.4: badge chất lượng nguồn → DAC, vd "FLAC • 24-bit • 96 kHz".
    var qualityBadge: String {
        var parts = [formatLabel].filter { !$0.isEmpty }
        if bitDepth > 0 { parts.append("\(bitDepth)-bit") }
        if sampleRate > 0 { parts.append(Self.formatSampleRate(sampleRate)) }
        return parts.joined(separator: " • ")
    }

    /// 96000 → "96 kHz", 44100 → "44.1 kHz".
    static func formatSampleRate(_ hz: Double) -> String {
        let k = hz / 1000
        if k.truncatingRemainder(dividingBy: 1) == 0 {
            return "\(Int(k)) kHz"
        }
        return String(format: "%.1f kHz", k)
    }

    /// Nhãn định dạng từ mimeType/tên file — cùng logic với Android.
    static func formatLabel(mimeType: String, title: String) -> String {
        let mt = mimeType.lowercased()
        let t = title.lowercased()
        if mt.contains("flac") || t.hasSuffix(".flac") { return "FLAC" }
        if mt.contains("wav") || t.hasSuffix(".wav") { return "WAV" }
        if mt.contains("mp3") || mt.contains("mpeg") { return "MP3" }
        if mt.contains("m4a") || mt.contains("mp4") || t.hasSuffix(".m4a") { return "M4A" }
        if mt.contains("ogg") || mt.contains("opus") { return "OGG" }
        if mt.contains("aiff") || t.hasSuffix(".aiff") { return "AIFF" }
        if mt.contains("dsd") || t.hasSuffix(".dsf") { return "DSD" }
        return "AUDIO"
    }

    private var player: AVPlayer?
    private var timeObserver: Any?

    /// Đọc (sample rate, bit depth) thật từ URL (không đoán).
    /// Bit depth = 0 khi format nén (MP3/AAC) không công bố.
    func audioInfo(of url: URL) async -> (sampleRate: Double, bitDepth: Int) {
        let asset = AVURLAsset(url: url)
        do {
            guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
                return (44100, 0)
            }
            let descs = try await track.load(.formatDescriptions)
            // CMFormatDescription và CMAudioFormatDescription là cùng một type
            // (compiler xác nhận) — không cần cast, dùng trực tiếp.
            guard let fmt = descs.first,
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else {
                return (44100, 0)
            }
            let sr = asbd.pointee.mSampleRate
            let bd = Int(asbd.pointee.mBitsPerChannel)
            return (sr > 0 ? sr : 44100, max(bd, 0))
        } catch {
            return (44100, 0)
        }
    }

    /// Đọc sample rate thật từ URL stream (không đoán).
    func sampleRate(of url: URL) async -> Double {
        await audioInfo(of: url).sampleRate
    }

    private func configureSession(sampleRate sr: Double) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setPreferredSampleRate(sr)
        try session.setActive(true)
    }

    /// Phát track: lấy stream URL → đọc sample rate → set session → phát.
    func play(_ track: Track, via api: MusicApiClient) async {
        stop()
        errorText = nil
        do {
            let url = try await api.streamURL(for: track.id)
            let info = await audioInfo(of: url)
            try configureSession(sampleRate: info.sampleRate)
            sampleRate = info.sampleRate
            bitDepth = info.bitDepth
            formatLabel = Self.formatLabel(mimeType: track.mimeType, title: track.title)
            let item = AVPlayerItem(url: url)
            player = AVPlayer(playerItem: item)
            player?.volume = 1.0  // Volume 100%, không attenuate
            player?.play()
            currentTrack = track
            isPlaying = true
        } catch MusicError.message(let msg) {
            errorText = msg
        } catch {
            errorText = "Không phát được: \(error.localizedDescription)"
        }
    }

    /// 4.3: Phát file đã tải offline (không cần mạng/Drive token).
    func playLocal(_ track: Track, fileURL: URL) async {
        stop()
        errorText = nil
        let info = await audioInfo(of: fileURL)
        do {
            try configureSession(sampleRate: info.sampleRate)
        } catch {
            errorText = "Không cấu hình được audio: \(error.localizedDescription)"
            return
        }
        sampleRate = info.sampleRate
        bitDepth = info.bitDepth
        formatLabel = Self.formatLabel(mimeType: track.mimeType, title: track.title)
        let item = AVPlayerItem(url: fileURL)
        player = AVPlayer(playerItem: item)
        player?.volume = 1.0
        player?.play()
        currentTrack = track
        isPlaying = true
    }

    func togglePlayPause() {
        guard player != nil else { return }
        if isPlaying {
            player?.pause()
        } else {
            player?.play()
        }
        isPlaying.toggle()
    }

    func seek(to seconds: Double) {
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
    }

    var duration: Double {
        player?.currentItem?.duration.seconds ?? 0
    }

    var currentPosition: Double {
        let s = player?.currentTime().seconds ?? 0
        return s.isFinite ? s : 0
    }

    func stop() {
        if let obs = timeObserver {
            player?.removeTimeObserver(obs)
            timeObserver = nil
        }
        player?.pause()
        player = nil
        isPlaying = false
        currentTrack = nil
        sampleRate = 0
        bitDepth = 0
        formatLabel = ""
    }
}
