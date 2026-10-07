package dev.randomframe.android

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Keep the page inside the status bar, navigation bar, cutout and keyboard. The WebView then sizes
    // itself to the usable area, so the page needs no safe-area CSS and focused fields stay above the IME.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val usable = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(usable.left, usable.top, usable.right, usable.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
