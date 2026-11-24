import SwiftUI

@main
struct PhotoBoothApp: App {
    @State private var pairing = Pairing.load()

    var body: some Scene {
        WindowGroup {
            ContentView(pairing: pairing)
                .onOpenURL { url in
                    if let p = Pairing(url: url) { p.save(); pairing = p }
                }
        }
    }
}
