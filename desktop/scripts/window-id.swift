// Print the CGWindowID of the first on-screen, normal-layer window owned by
// the process with the given pid: what `screencapture -l` wants.
import CoreGraphics
import Foundation

let pid = Int(CommandLine.arguments.dropFirst().first ?? "") ?? -1
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in windows {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner == pid,
          let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let id = w[kCGWindowNumber as String] as? Int else { continue }
    print(id)
    exit(0)
}
exit(1)
