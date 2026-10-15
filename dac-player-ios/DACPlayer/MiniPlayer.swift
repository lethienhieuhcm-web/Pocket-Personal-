import SwiftUI

/// Mini player hiển thị phía trên TabView khi đang phát nhạc.
/// Bấm vào → mở FullPlayer. Nút play/pause nhanh.
struct MiniPlayer: View {
    @EnvironmentObject var engine: AudioEngine
    @Binding var showFullPlayer: Bool

    var body: some View {
        if let track = engine.currentTrack {
            Button(action: { showFullPlayer = true }) {
                HStack(spacing: 12) {
                    // Artwork placeholder (sẽ thay bằng ảnh thật khi có cache)
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.gray.opacity(0.3))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Image(systemName: "music.note")
                                .foregroundColor(.secondary)
                        )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title)
                            .font(.subheadline)
                            .lineLimit(1)
                        if !engine.formatLabel.isEmpty {
                            Text(engine.formatLabel)
                                .font(.caption2)
                                .foregroundColor(.secondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    Button(action: {
                        engine.togglePlayPause()
                    }) {
                        Image(systemName: engine.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title3)
                            .foregroundColor(.primary)
                    }
                    .buttonStyle(PlainButtonStyle())
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.systemBackground))
                .cornerRadius(12)
                .shadow(radius: 4)
                .padding(.horizontal, 12)
            }
            .buttonStyle(PlainButtonStyle())
        }
    }
}
