package bg.qrorders.device

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Автостарт след включване на таблета (реш. 11). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
