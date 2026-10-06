package io.crates.keyring

import android.content.Context

// JNI entry point exported by the android-native-keyring-store crate, linked into random_frame_lib.
// Tauri does not initialize ndk-context, which that store needs to reach SharedPreferences and Keystore.
class Keyring {
    companion object {
        external fun initializeNdkContext(context: Context)
    }
}
