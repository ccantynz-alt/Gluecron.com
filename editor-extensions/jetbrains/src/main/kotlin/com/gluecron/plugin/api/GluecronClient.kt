package com.gluecron.plugin.api

import com.gluecron.plugin.GluecronPlugin
import com.gluecron.plugin.auth.AuthService
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Thin wrapper around `/api/v2` on a Gluecron server.
 *
 * Mirrors the slice that the VS Code extension uses so behaviour stays
 * consistent across editors:
 *
 *   - GET  /api/v2/user                  — token validation
 *   - POST /api/v2/ai/commit-message     — staged-diff → commit text
 *
 * Construction is cheap (ktor reuses the engine) but tests can swap a
 * custom HttpClient via the secondary constructor.
 */
class GluecronClient(
    private val host: String = GluecronPlugin.DEFAULT_HOST,
    private val token: String? = AuthService.getInstance().getToken(),
    private val client: HttpClient = defaultClient(),
) {

    private val baseUrl: String = host.trimEnd('/')

    @Serializable
    data class User(val username: String? = null, val email: String? = null)

    @Serializable
    data class CommitMessageRequest(val diff: String, val style: String = "conventional")

    @Serializable
    data class CommitMessageResponse(val subject: String = "", val body: String = "")

    /**
     * Probe `/api/v2/user` with the active token. Returns the user record
     * on success, null on 401/network error — the caller decides how to
     * surface that to the user.
     */
    suspend fun whoami(): User? = runCatching {
        val res: HttpResponse = client.get("$baseUrl/api/v2/user") {
            authHeader()
        }
        if (res.status != HttpStatusCode.OK) return@runCatching null
        res.body<User>()
    }.getOrNull()

    /**
     * Ask the server to draft a commit message from a unified-diff blob.
     * Throws on any non-2xx — VCS handlers wrap this in their progress UI.
     */
    suspend fun aiCommitMessage(diff: String): CommitMessageResponse {
        val res: HttpResponse = client.post("$baseUrl/api/v2/ai/commit-message") {
            authHeader()
            contentType(ContentType.Application.Json)
            setBody(CommitMessageRequest(diff = diff))
        }
        if (!res.status.isSuccess()) {
            error("Gluecron API ${res.status.value}: ${res.body<String>().take(200)}")
        }
        return res.body()
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authHeader() {
        val t = token
        if (!t.isNullOrBlank()) {
            headers {
                append(HttpHeaders.Authorization, "Bearer $t")
                append(HttpHeaders.Accept, ContentType.Application.Json.toString())
            }
        }
    }

    companion object {
        private val LAX_JSON = Json {
            ignoreUnknownKeys = true
            isLenient = true
            encodeDefaults = true
        }

        fun defaultClient(): HttpClient = HttpClient(CIO) {
            install(ContentNegotiation) { json(LAX_JSON) }
            expectSuccess = false
        }
    }
}

private fun HttpStatusCode.isSuccess(): Boolean = value in 200..299
