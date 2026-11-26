import ExpoModulesCore

public class BbqBleModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BbqBle")

    Events("state", "discovered", "connected", "disconnected", "failedToConnect", "value", "restored")

    OnDestroy {
      DispatchQueue.main.async { BbqCentral.shared.detach() }
    }

    // JS calls this after it subscribes to every event. It flushes the queue.
    AsyncFunction("attach") {
      BbqCentral.shared.attach { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }.runOnQueue(.main)

    AsyncFunction("state") { () -> String in
      BbqCentral.shared.stateName
    }.runOnQueue(.main)

    AsyncFunction("startScan") {
      BbqCentral.shared.startScan()
    }.runOnQueue(.main)

    AsyncFunction("stopScan") {
      BbqCentral.shared.stopScan()
    }.runOnQueue(.main)

    AsyncFunction("connect") { (id: String, promise: Promise) in
      BbqCentral.shared.connect(id, promise)
    }.runOnQueue(.main)

    AsyncFunction("cancel") { (id: String) in
      BbqCentral.shared.cancel(id)
    }.runOnQueue(.main)

    AsyncFunction("discover") { (id: String, promise: Promise) in
      BbqCentral.shared.discover(id, promise)
    }.runOnQueue(.main)

    AsyncFunction("setNotify") { (id: String, service: String?, char: String, on: Bool, promise: Promise) in
      BbqCentral.shared.setNotify(id, service, char, on, promise)
    }.runOnQueue(.main)

    AsyncFunction("read") { (id: String, service: String?, char: String, promise: Promise) in
      BbqCentral.shared.read(id, service, char, promise)
    }.runOnQueue(.main)

    AsyncFunction("write") { (id: String, service: String?, char: String, bytes: [Double], withResponse: Bool, promise: Promise) in
      BbqCentral.shared.write(id, service, char, bytes, withResponse, promise)
    }.runOnQueue(.main)

    AsyncFunction("restoredIds") { () -> [String] in
      BbqCentral.shared.restoredIds
    }.runOnQueue(.main)

    AsyncFunction("setRestoreHint") { (text: String) in
      BbqCentral.shared.setRestoreHint(text)
    }.runOnQueue(.main)

    AsyncFunction("beginBackgroundWork") { (ms: Double) in
      BbqCentral.shared.beginBackgroundWork(ms: ms)
    }.runOnQueue(.main)

    AsyncFunction("endBackgroundWork") {
      BbqCentral.shared.endBackgroundWork()
    }.runOnQueue(.main)
  }
}
