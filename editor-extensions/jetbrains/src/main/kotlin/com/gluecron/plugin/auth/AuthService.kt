package com.gluecron.plugin.auth

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger

/**
 * Token storage for the Gluecron PAT.
 *
 * Resolution order (matches the VS Code extension's behaviour):
 *   1. IDE password safe (CredentialAttributes — OS keychain on
 *      macOS/Windows/Linux when available, encrypted file fallback).
 *   2. Environment variable `GLUECRON_TOKEN` — handy for headless setups
 *      and JetBrains Gateway sessions where the keychain isn't reachable.
 *
 * Never stored in plain settings.xml — tokens leak through every backup
 * surface IDEA has.
 */
@Service(Service.Level.APP)
class AuthService {

    private val attributes: CredentialAttributes by lazy {
        CredentialAttributes(generateServiceName(SERVICE_NAME, TOKEN_KEY))
    }

    /**
     * Returns the active token, preferring the IDE password safe.
     * Returns null if no token is configured.
     */
    fun getToken(): String? {
        val stored = PasswordSafe.instance.getPassword(attributes)
        if (!stored.isNullOrBlank()) return stored.trim()
        val env = System.getenv("GLUECRON_TOKEN")
        if (!env.isNullOrBlank()) return env.trim()
        return null
    }

    /**
     * Persist a PAT in the password safe. Pass null/blank to clear.
     */
    fun setToken(value: String?) {
        val trimmed = value?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            PasswordSafe.instance.set(attributes, null)
            LOG.info("Gluecron token cleared from password safe.")
            return
        }
        PasswordSafe.instance.set(attributes, Credentials(USER_PLACEHOLDER, trimmed))
        LOG.info("Gluecron token stored in password safe.")
    }

    /** True if any token (safe or env) is available. */
    fun isSignedIn(): Boolean = !getToken().isNullOrBlank()

    companion object {
        private const val SERVICE_NAME = "Gluecron"
        private const val TOKEN_KEY = "personal-access-token"
        // PasswordSafe wants a user — the value is meaningless to us but
        // some backends key on it, so use a stable placeholder.
        private const val USER_PLACEHOLDER = "gluecron"

        private val LOG = Logger.getInstance(AuthService::class.java)

        @JvmStatic
        fun getInstance(): AuthService =
            ApplicationManager.getApplication().getService(AuthService::class.java)
    }
}
