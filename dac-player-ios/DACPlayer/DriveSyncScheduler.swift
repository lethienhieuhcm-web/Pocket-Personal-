import BackgroundTasks
import Foundation

/// v3.0: Background sync thư viện nhạc mỗi 6-8 giờ.
/// Gọi POST /api/dac/sync (server tự lấy Drive token từ D1).
/// iOS có thể kill task bất cứ lúc nào — thiết kế idempotent, retry lần sau.
enum DriveSyncScheduler {
    static let taskId = "one.lethanhdong.dac.sync"

    static func register(api: MusicApiClient) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            scheduleNext()
            Task {
                do {
                    try await api.syncIndex()
                    refreshTask.setTaskCompleted(success: true)
                } catch {
                    refreshTask.setTaskCompleted(success: false)
                }
            }
            // Hết thời gian → đánh dấu hoàn thành (tránh bị phạt)
            refreshTask.expirationHandler = {
                refreshTask.setTaskCompleted(success: false)
            }
        }
    }

    static func scheduleNext() {
        let req = BGAppRefreshTaskRequest(identifier: taskId)
        // Sớm nhất 6h sau
        req.earliestBeginDate = Date(timeIntervalSinceNow: 6 * 3600)
        try? BGTaskScheduler.shared.submit(req)
    }

    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
    }
}
