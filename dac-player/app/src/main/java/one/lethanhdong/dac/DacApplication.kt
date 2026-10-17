package one.lethanhdong.dac

import android.app.Application
import dagger.hilt.android.HiltAndroidApp
import one.lethanhdong.dac.player.QuirkManager

/**
 * 2.3: Hilt Application — entry point cho dependency injection.
 */
@HiltAndroidApp
class DacApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Seed quirks table (7.6) nếu chưa có
        QuirkManager.init(this)
    }
}
