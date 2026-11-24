import SwiftUI

@main
struct PhotoBoothApp: App {
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup { BoothView() }
    }
}
