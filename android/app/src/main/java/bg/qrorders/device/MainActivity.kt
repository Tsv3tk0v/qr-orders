package bg.qrorders.device

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * Обвивка за кухня, табло и киоск (реш. 11): цял екран, без изход за клиентите,
 * автостарт, печат ESC/POS по LAN, „поръчайте на щанда“ + звук при липса на връзка (реш. 18).
 * Самият екран (кухня/табло/киоск) се избира от уеб приложението при сдвояването.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var offline: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var cornerTaps = 0
    private var lastTap = 0L
    private var isOffline = false
    private val prefs by lazy { getSharedPreferences("device", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (prefs.getString("url", null) == null) showSetup() else showWeb()
    }

    // --- Настройка: адрес на обекта и ПИН за изход ---
    private fun showSetup() {
        val pad = (24 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad); setBackgroundColor(Color.WHITE)
        }
        fun label(id: Int) = TextView(this).apply { setText(id); setTextColor(Color.DKGRAY); textSize = 16f; setPadding(0, pad / 2, 0, 4) }
        box.addView(TextView(this).apply { setText(R.string.setup_title); textSize = 26f; setTextColor(Color.BLACK) })
        box.addView(label(R.string.setup_url))
        val url = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI; setText(prefs.getString("url", "https://")); textSize = 20f
        }
        box.addView(url)
        box.addView(label(R.string.setup_pin))
        val pin = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD; textSize = 20f
            setText(prefs.getString("pin", ""))
        }
        box.addView(pin)
        box.addView(Button(this).apply {
            setText(R.string.setup_save)
            setOnClickListener {
                val u = url.text.toString().trim().trimEnd('/')
                val p = pin.text.toString().trim()
                when {
                    !(u.startsWith("https://") || (u.startsWith("http://") && u.contains(".nip.io"))) ->
                        Toast.makeText(this@MainActivity, R.string.setup_bad_url, Toast.LENGTH_LONG).show()
                    !p.matches(Regex("\\d{4}")) -> Toast.makeText(this@MainActivity, R.string.setup_bad_pin, Toast.LENGTH_LONG).show()
                    else -> { prefs.edit().putString("url", u).putString("pin", p).apply(); showWeb() }
                }
            }
        })
        if (prefs.getString("url", null) != null) {
            box.addView(Button(this).apply {
                setText(R.string.setup_exit)
                setOnClickListener { stopKiosk(); finishAffinity() }
            })
        }
        setContentView(box)
    }

    // --- Уеб екранът ---
    @SuppressLint("SetJavaScriptEnabled")
    private fun showWeb() {
        val root = FrameLayout(this)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.textZoom = 100
            addJavascriptInterface(Bridge(), "QRBridge")
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                    if (req.isForMainFrame) setOffline(true)
                }
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    handler.cancel(); setOffline(true)
                }
                override fun onPageFinished(view: WebView, url: String) { if (!isOffline) offline.visibility = View.GONE }
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    // Само адресите на обекта; външни връзки не се отварят на устройството.
                    return req.url.host != android.net.Uri.parse(prefs.getString("url", "")).host
                }
            }
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        offline = TextView(this).apply {
            text = getString(R.string.offline_title) + "\n\n" + getString(R.string.offline_text)
            textSize = 34f; gravity = Gravity.CENTER; setTextColor(Color.WHITE); setBackgroundColor(Color.parseColor("#1E1714"))
            visibility = View.GONE
        }
        root.addView(web)
        root.addView(offline)
        setContentView(root)
        hideSystemUi()
        startKiosk()
        web.loadUrl(prefs.getString("url", "")!! + "/device")
    }

    private fun setOffline(value: Boolean) {
        isOffline = value
        offline.visibility = if (value) View.VISIBLE else View.GONE
        if (value) {
            handler.removeCallbacksAndMessages(null)
            alarm()
            handler.postDelayed({ isOffline = false; web.reload() }, 10_000)
        }
    }

    /** Звуков сигнал за персонала, докато няма връзка. */
    private fun alarm() {
        try { ToneGenerator(AudioManager.STREAM_ALARM, 80).startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 600) } catch (_: Exception) {}
    }

    // --- Цял екран и заключване ---
    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
    }

    /** Закачане на екрана (screen pinning); при настроен „device owner“ — пълен киоск режим без въпрос. */
    private fun startKiosk() {
        try {
            val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val pinned = if (Build.VERSION.SDK_INT >= 23) am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE else false
            if (!pinned) startLockTask()
        } catch (_: Exception) {}
    }
    private fun stopKiosk() { try { stopLockTask() } catch (_: Exception) {} }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) hideSystemUi() }

    /** Скрит изход за персонала: 5 бързи докосвания в горния ляв ъгъл → ПИН → настройки. */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_DOWN && ev.x < 80 * resources.displayMetrics.density && ev.y < 80 * resources.displayMetrics.density) {
            val now = System.currentTimeMillis()
            cornerTaps = if (now - lastTap < 600) cornerTaps + 1 else 1
            lastTap = now
            if (cornerTaps >= 5) { cornerTaps = 0; askPin() }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun askPin() {
        val input = EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD }
        AlertDialog.Builder(this).setTitle(R.string.pin_title).setView(input)
            .setPositiveButton(R.string.ok) { _, _ ->
                if (input.text.toString() == prefs.getString("pin", null)) { stopKiosk(); showSetup() }
                else Toast.makeText(this, R.string.pin_wrong, Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null).show()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() // без изход от приложението
    }

    /** Достъпно от уеб страницата като window.QRBridge. */
    inner class Bridge {
        @JavascriptInterface
        fun printEscPos(host: String, port: Int, base64: String): Boolean = Printer.print(host, port, base64)

        @JavascriptInterface
        fun version(): String = "1.0"
    }
}
