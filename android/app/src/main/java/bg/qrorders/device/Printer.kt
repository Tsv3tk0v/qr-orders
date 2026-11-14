package bg.qrorders.device

import android.util.Base64
import java.net.InetSocketAddress
import java.net.Socket

/** Изпраща готовите байтове ESC/POS до LAN принтера (обикновено порт 9100). */
object Printer {
    private val HOST = Regex("^[A-Za-z0-9.:-]{1,100}$")

    fun print(host: String, port: Int, base64: String): Boolean {
        if (!HOST.matches(host) || port !in 1..65535) return false
        return try {
            val data = Base64.decode(base64, Base64.DEFAULT)
            Socket().use { s ->
                s.connect(InetSocketAddress(host, port), 4000)
                s.soTimeout = 4000
                s.getOutputStream().apply { write(data); flush() }
            }
            true
        } catch (_: Exception) {
            false
        }
    }
}
