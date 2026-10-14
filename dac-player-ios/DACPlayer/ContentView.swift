import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("DAC Player")
                .font(.largeTitle)
                .bold()
            Text("Bit-perfect music for USB DAC")
                .foregroundStyle(.secondary)
            Text("Version 0.1.0 (build 1)")
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
