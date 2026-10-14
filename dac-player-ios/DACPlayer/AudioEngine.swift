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
    @Published var errorText: String? = nil

    private var player: AVPlayer?
    private var timeObserver: Any?

    /// Đọc sample rate thật từ URL stream (không đoán).
    func sampleRate(of url: URL) async -> Double {
        let asset = AVURLAsset(url: url)
        do {
            guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
                return 44100
            }
            let descs = try await track.load(.formatDescriptions)
            // CMFormatDescription và CMAudioFormatDescription là cùng một type
            // (compiler xác nhận) — không cần cast, dùng trực tiếp.
            guard let fmt = descs.first,
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else {
                return 44100
            }
            let sr = asbd.pointee.mSampleRate
            return sr > 0 ? sr : 44100
        } catch {
            return 44100
        }
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
            let sr = await sampleRate(of: url)
            try configureSession(sampleRate: sr)
            sampleRate = sr
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
    }
}
