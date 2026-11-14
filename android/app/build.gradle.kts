plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "bg.qrorders.device"
    compileSdk = 35
    defaultConfig {
        applicationId = "bg.qrorders.device"
        minSdk = 24          // Android 7 — повечето евтини таблети и Android TV кутии
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            // Подписва се с ключа за отстраняване на грешки, за да се инсталира директно (без Google Play).
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
