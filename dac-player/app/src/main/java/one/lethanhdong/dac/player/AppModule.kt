package one.lethanhdong.dac.player

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * 2.3: Hilt module — cung cấp Room database và DAO.
 * Singleton scope: 1 database instance cho cả app.
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideMusicDatabase(
        @ApplicationContext context: Context
    ): MusicDatabase = MusicDatabase.getInstance(context)

    @Provides
    @Singleton
    fun provideTrackDao(db: MusicDatabase): TrackDao = db.trackDao()

    /** 4.3: DAO cho file nhạc offline. */
    @Provides
    @Singleton
    fun provideOfflineTrackDao(db: MusicDatabase): OfflineTrackDao = db.offlineTrackDao()

    /** v3.0: DAO cho folder cache. */
    @Provides
    @Singleton
    fun provideFolderDao(db: MusicDatabase): FolderDao = db.folderDao()

    /**
     * 4.1: PlayerManager singleton — 1 ExoPlayer duy nhất cho cả app.
     * Nhạc tiếp tục phát khi chuyển giữa các màn hình (Main ↔ Folder),
     * đúng kiến trúc của Spotify/UAPP. Dùng application context để
     * ExoPlayer không giữ reference tới Activity đã destroy.
     */
    @Provides
    @Singleton
    fun providePlayerManager(
        @ApplicationContext context: Context
    ): PlayerManager = PlayerManager(context)

    /** 4.9: SleepTimer singleton — sống qua chuyển màn hình, tự pause PlayerManager. */
    @Provides
    @Singleton
    fun provideSleepTimer(playerManager: PlayerManager): SleepTimer = SleepTimer(playerManager)
}
