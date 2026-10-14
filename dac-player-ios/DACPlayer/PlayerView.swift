import SwiftUI
import AVFoundation

/// Màn hình phát nhạc — Play/Pause/Seek, hiện sample rate DAC đang dùng.
struct PlayerView: View {
    @EnvironmentObject var engine: AudioEngine
    @Environment(\.dismiss) private var dismiss

    @State private var position: Double = 0
    @State private var duration: Double = 0
    @State private var isSeeking = false
    @State private var timer: Timer?

    var body: some View {
        // 4.8: không dùng .sheet (cấm modal) — view này luôn được push qua
        // navigationDestination từ Library/Search nên không cần NavigationStack riêng.
            VStack(spacing: 20) {
                if let track = engine.currentTrack {
                    Text(track.title)
                        .font(.title2)
                        .bold()
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    // 4.4: badge chất lượng nguồn → DAC (vd "FLAC • 24-bit • 96 kHz")
                    if !engine.qualityBadge.isEmpty {
                        Text(engine.qualityBadge)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }

                Slider(value: $position, in: 0...(max(duration, 1))) { editing in
                    isSeeking = editing
                    if !editing {
                        engine.seek(to: position)
                    }
                }
                .disabled(duration <= 0)

                HStack {
                    Text(formatTime(position))
                    Spacer()
                    Text(formatTime(duration))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .monospacedDigit()

                Button {
                    engine.togglePlayPause()
                } label: {
                    Image(systemName: engine.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 64))
                }

                if let err = engine.errorText {
                    Text(err)
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Đang phát")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Đóng") {
                        engine.stop()
                        dismiss()
                    }
                }
            }
            .onAppear(perform: startTimer)
            .onDisappear(perform: stopTimer)
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            Task { @MainActor in
                let d = engine.duration
                if d.isFinite && d > 0 { duration = d }
                if !isSeeking {
                    // Đọc position qua KVO-less: dùng currentTime qua engine là đủ
                    position = engine.currentPosition
                }
            }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func formatTime(_ s: Double) -> String {
        guard s.isFinite && s >= 0 else { return "0:00" }
        let m = Int(s) / 60
        let sec = Int(s) % 60
        return String(format: "%d:%02d", m, sec)
    }
}
