import UIKit

/// One `UIBackgroundTask` that always ends: on `end()`, on its timer, or on expiry.
/// Main queue only.
final class BbqBackgroundTask {
  private let name: String
  private var identifier = UIBackgroundTaskIdentifier.invalid
  private var timer: DispatchWorkItem?

  init(name: String) {
    self.name = name
  }

  var isActive: Bool { identifier != .invalid }

  func begin() {
    guard identifier == .invalid else { return }
    identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
      self?.end()
    }
  }

  /// (Re)arm the timer that ends the task.
  func end(after seconds: TimeInterval) {
    timer?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.end() }
    timer = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  func end() {
    timer?.cancel()
    timer = nil
    guard identifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
  }
}
