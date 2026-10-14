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

    private var player: AVQueuePlayer?
    private var timeObserver: Any?
    /// 4.5: queue (item → track) để biết bài nào đang phát khi tự chuyển.
    private var queue: [(item: AVPlayerItem, track: Track)] = []
    private var currentItemObs: NSKeyValueObservation?
    private var prefetchTask: Task<Void, Never>?

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
            applyQuality(track: track, info: info)
            startQueue(items: [(AVPlayerItem(url: url), track)])
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
        applyQuality(track: track, info: info)
        startQueue(items: [(AVPlayerItem(url: fileURL), track)])
    }

    /**
     * 4.5: Phát 1 track + prefetch 5 bài sau vào queue → chuyển bài gapless.
     * Dùng cho cả Thư viện và Thư mục (truyền danh sách đang hiển thị).
     */
    func playWithQueue(_ track: Track, from tracks: [Track], via api: MusicApiClient) async {
        prefetchTask?.cancel()
        if let local = OfflineManager.shared.localFile(trackId: track.id) {
            await playLocal(track, fileURL: local)
        } else {
            await play(track, via: api)
        }
        prefetchTask = Task {
            guard let idx = tracks.firstIndex(where: { $0.id == track.id }) else { return }
            for t in tracks.dropFirst(idx + 1).prefix(5) {
                if Task.isCancelled { return }
                do {
                    if let local = OfflineManager.shared.localFile(trackId: t.id) {
                        enqueueLocal(t, fileURL: local)
                    } else {
                        let url = try await api.streamURL(for: t.id)
                        enqueue(t, url: url)
                    }
                } catch {
                    // Prefetch lỗi → bỏ qua, bài đó sẽ load khi tới lượt
                }
            }
        }
    }

    /// 4.9: Phát toàn bộ danh sách track (dùng khi mở playlist) —
    /// bài đầu phát ngay, các bài sau enqueue dần (bỏ qua bài lỗi).
    func playAll(_ tracks: [Track], via api: MusicApiClient) async {
        prefetchTask?.cancel()
        guard let first = tracks.first else { return }
        if let local = OfflineManager.shared.localFile(trackId: first.id) {
            await playLocal(first, fileURL: local)
        } else {
            await play(first, via: api)
        }
        // Bài đầu lỗi (không phát được) → không enqueue tiếp.
        guard player != nil else { return }
        for t in tracks.dropFirst() {
            do {
                if let local = OfflineManager.shared.localFile(trackId: t.id) {
                    enqueueLocal(t, fileURL: local)
                } else {
                    let url = try await api.streamURL(for: t.id)
                    enqueue(t, url: url)
                }
            } catch {
                // Bỏ qua bài lỗi (vd: file đã xoá), giữ các bài còn lại.
            }
        }
    }

    /// 4.5: Thêm vào cuối queue (gapless khi cùng format).
    func enqueue(_ track: Track, url: URL) {
        let item = AVPlayerItem(url: url)
        queue.append((item, track))
        player?.insert(item, after: nil)
        publishQueue()
    }

    func enqueueLocal(_ track: Track, fileURL: URL) {
        let item = AVPlayerItem(url: fileURL)
        queue.append((item, track))
        player?.insert(item, after: nil)
        publishQueue()
    }

    /// Dựng AVQueuePlayer mới với các item, theo dõi currentItem để cập nhật UI.
    private func startQueue(items: [(AVPlayerItem, Track)]) {
        let q = AVQueuePlayer()
        q.volume = 1.0  // Volume 100%, không attenuate
        queue = items
        // 4.9: bài đầu của queue mới chưa phải "hết bài" → bỏ qua 1 lần sleep check.
        skipSleepCheck = true
        publishQueue()
        for (item, _) in items {
            q.insert(item, after: nil)
        }
        player = q
        currentItemObs = q.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.syncCurrentTrack() }
        }
        if let first = items.first {
            currentTrack = first.1
        }
        q.play()
        isPlaying = true
    }

    /// Queue tự chuyển bài → cập nhật track + quality đang phát.
    private func syncCurrentTrack() {
        guard let cur = player?.currentItem else { return }
        // Dọn các item đã phát xong khỏi đầu queue
        if let idx = queue.firstIndex(where: { $0.item === cur }) {
            queue.removeFirst(idx)
        }
        guard let entry = queue.first(where: { $0.item === cur }) else { return }
        // 4.9: "hết bài" — chỉ khi queue TỰ chuyển (không phải lần đầu dựng queue
        // hay user đổi bài tay, 2 trường hợp này đã set skipSleepCheck).
        let auto = !skipSleepCheck
        skipSleepCheck = false
        publishQueue()
        if auto, case .endOfTrack = sleepState {
            fireSleep()
        }
        let track = entry.track
        currentTrack = track
        formatLabel = Self.formatLabel(mimeType: track.mimeType, title: track.title)
        // Đọc lại sample rate/bit depth của bài mới (header parse, nhanh)
        Task {
            let url: URL
            if let local = OfflineManager.shared.localFile(trackId: track.id) {
                url = local
            } else {
                // Không có URL gốc ở đây — dùng asset của item đang phát
                guard let assetURL = (cur.asset as? AVURLAsset)?.url else { return }
                url = assetURL
            }
            let info = await audioInfo(of: url)
            sampleRate = info.sampleRate
            bitDepth = info.bitDepth
        }
    }

    private func applyQuality(track: Track, info: (sampleRate: Double, bitDepth: Int)) {
        sampleRate = info.sampleRate
        bitDepth = info.bitDepth
        formatLabel = Self.formatLabel(mimeType: track.mimeType, title: track.title)
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
        prefetchTask?.cancel()
        prefetchTask = nil
        currentItemObs?.invalidate()
        currentItemObs = nil
        if let obs = timeObserver {
            player?.removeTimeObserver(obs)
            timeObserver = nil
        }
        player?.pause()
        player?.removeAllItems()
        player = nil
        queue.removeAll()
        isPlaying = false
        currentTrack = nil
        sampleRate = 0
        bitDepth = 0
        formatLabel = ""
        publishQueue()
    }

    // MARK: - 4.9: Queue reorder/remove + sleep timer

    /// Snapshot queue cho SwiftUI (kể cả bài đang phát ở [0]).
    @Published private(set) var queueSnapshot: [Track] = []

    private func publishQueue() {
        queueSnapshot = queue.map { $0.track }
    }

    /// Đổi chỗ 2 bài trong queue. Không cho di chuyển bài đang phát ([0]).
    func moveTrack(from: Int, to: Int) {
        guard from != to, from >= 1, to >= 1,
              queue.indices.contains(from), queue.indices.contains(to),
              let q = player else { return }
        let entry = queue.remove(at: from)
        queue.insert(entry, at: to)
        q.remove(entry.item)
        q.insert(entry.item, after: queue[to - 1].item)
        publishQueue()
    }

    /// Xoá 1 bài khỏi queue. Không xoá bài đang phát ([0]) / khi chỉ còn 1 bài.
    @discardableResult
    func removeTrack(at index: Int) -> Bool {
        guard queue.count > 1, index >= 1, queue.indices.contains(index),
              let q = player else { return false }
        let entry = queue.remove(at: index)
        q.remove(entry.item)
        publishQueue()
        return true
    }

    /// 4.9: trạng thái hẹn giờ ngủ.
    enum SleepState: Equatable {
        case off
        case countdown(TimeInterval)
        case endOfTrack
    }
    @Published private(set) var sleepState: SleepState = .off
    private var sleepTask: Task<Void, Never>?

    /// Bỏ qua 1 lần kiểm tra "hết bài" ngay sau khi dựng queue mới
    /// (bài đầu tiên chưa phải "hết bài"; user đổi bài tay cũng không tính).
    private var skipSleepCheck = false

    /// Hẹn giờ dừng phát sau [minutes] phút.
    func startSleep(minutes: Int) {
        cancelSleep()
        let total = TimeInterval(minutes * 60)
        sleepState = .countdown(total)
        sleepTask = Task {
            var left = total
            while left > 0 && !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                left -= 1
                self.sleepState = .countdown(max(0, left))
            }
            if !Task.isCancelled { self.fireSleep() }
        }
    }

    /// Dừng phát khi hết bài đang phát (chỉ khi tự chuyển, không tính đổi tay).
    func startSleepEndOfTrack() {
        cancelSleep()
        sleepState = .endOfTrack
    }

    func cancelSleep() {
        sleepTask?.cancel()
        sleepTask = nil
        if sleepState != .off { sleepState = .off }
    }

    private func fireSleep() {
        sleepState = .off
        player?.pause()
        isPlaying = false
    }

    var sleepStatusText: String {
        switch sleepState {
        case .off:
            return "Hẹn giờ: tắt"
        case .endOfTrack:
            return "Hẹn giờ: dừng khi hết bài đang phát"
        case .countdown(let left):
            let s = Int(left)
            return String(format: "Hẹn giờ: còn %d:%02d", s / 60, s % 60)
        }
    }
}
