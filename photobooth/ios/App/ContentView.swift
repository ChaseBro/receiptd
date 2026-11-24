import SwiftUI

struct ContentView: View {
    let pairing: Pairing?

    var body: some View {
        VStack(spacing: 16) {
            Text("Photo Booth").font(.largeTitle.bold())
            if let pairing {
                Text("Paired with \(pairing.server.host() ?? pairing.server.absoluteString)")
                    .foregroundStyle(.secondary)
            } else {
                Text("Scan the setup code to connect.").foregroundStyle(.secondary)
            }
        }
        .padding()
    }
}

#Preview { ContentView(pairing: nil) }
