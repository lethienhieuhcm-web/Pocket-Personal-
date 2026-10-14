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
}
