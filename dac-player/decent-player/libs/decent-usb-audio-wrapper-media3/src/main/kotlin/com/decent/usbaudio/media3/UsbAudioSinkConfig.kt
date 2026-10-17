package com.decent.usbaudio.media3

/**
 * Configuration for [UsbAudioSink].
 *
 * @param bitPerfectEnabled When true, audio is sent directly to the USB DAC
 *        bypassing the Android audio stack entirely.
 * @param forceRouteToSpeaker When true, the delegate AudioTrack is routed to
 *        the built-in speaker to prevent AudioFlinger from opening the USB device.
 */
data class UsbAudioSinkConfig(
    val bitPerfectEnabled: Boolean = true,
    val forceRouteToSpeaker: Boolean = true,
    /** Số URB trong ring buffer (mặc định 80 ≈ 80ms @44.1kHz). */
    val numUrbs: Int = 80
)
