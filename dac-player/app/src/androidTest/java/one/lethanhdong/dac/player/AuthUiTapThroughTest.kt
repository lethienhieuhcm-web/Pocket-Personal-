package one.lethanhdong.dac.player

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.typeText
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.ext.junit.runners.AndroidJUnit4
import one.lethanhdong.dac.AuthActivity
import one.lethanhdong.dac.FolderActivity
import one.lethanhdong.dac.MainActivity
import one.lethanhdong.dac.QueueActivity
import one.lethanhdong.dac.R
import one.lethanhdong.dac.SearchActivity
import one.lethanhdong.dac.SessionsActivity
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.10: UI tap-through test trên emulator CI (reactivecircus runner).
 * Không cần tài khoản thật, không chạm network thật:
 * mọi case đều chạy ở trạng thái CHƯA đăng nhập.
 *
 * Mục tiêu duy nhất: bắt crash khi mở/tap màn hình — họ bug mà
 * unit test không thấy (inflater lỗi, findViewById sai id, redirect
 * thiếu finish, coroutine không catch...).
 */
@RunWith(AndroidJUnit4::class)
class AuthUiTapThroughTest {

    @Test
    fun authScreen_rendersWithoutCrash() {
        ActivityScenario.launch(AuthActivity::class.java).use {
            onView(withId(R.id.emailInput)).check(matches(isDisplayed()))
            onView(withId(R.id.passwordInput)).check(matches(isDisplayed()))
            onView(withId(R.id.loginButton)).check(matches(isDisplayed()))
            onView(withId(R.id.registerButton)).check(matches(isDisplayed()))
            onView(withId(R.id.googleSignInButton)).check(matches(isDisplayed()))
            onView(withId(R.id.forgotPasswordButton)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun login_emptyFields_showsInlineError() {
        ActivityScenario.launch(AuthActivity::class.java).use {
            onView(withId(R.id.loginButton)).perform(click())
            // Validation local -> lỗi inline, không gọi network, không crash
            onView(withId(R.id.errorText)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun login_invalidEmail_showsInlineError() {
        ActivityScenario.launch(AuthActivity::class.java).use {
            onView(withId(R.id.emailInput))
                .perform(typeText("not-an-email"), closeSoftKeyboard())
            onView(withId(R.id.passwordInput))
                .perform(typeText("password123"), closeSoftKeyboard())
            onView(withId(R.id.loginButton)).perform(click())
            onView(withId(R.id.errorText)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun register_emptyFields_showsInlineError() {
        ActivityScenario.launch(AuthActivity::class.java).use {
            onView(withId(R.id.registerButton)).perform(click())
            onView(withId(R.id.errorText)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun forgotPassword_emptyEmail_showsInlineError() {
        ActivityScenario.launch(AuthActivity::class.java).use {
            onView(withId(R.id.forgotPasswordButton)).perform(click())
            onView(withId(R.id.errorText)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun googleSignInButton_tap_doesNotCrash() {
        // Trên emulator CI không có Play Services/account thật:
        // kỳ vọng là lỗi inline (catch trong doGoogleSignIn), KHÔNG crash.
        // Coroutine chạy trên lifecycleScope nên sleep để nó xử lý xong.
        ActivityScenario.launch(AuthActivity::class.java).use {
            onView(withId(R.id.googleSignInButton)).perform(click())
            Thread.sleep(4000)
            // App vẫn sống: màn hình auth còn hiển thị
            onView(withId(R.id.emailInput)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun mainActivity_withoutSession_redirectsToAuth() {
        ActivityScenario.launch(MainActivity::class.java).use {
            // Chưa đăng nhập -> MainActivity tự start AuthActivity + finish,
            // không crash, không kẹt màn hình đen
            onView(withId(R.id.emailInput)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun folderActivity_withoutSession_noCrash() {
        ActivityScenario.launch(FolderActivity::class.java).use {
            // Chỉ cần không crash khi mở trực tiếp (deep link/task re-creation)
            Thread.sleep(1000)
        }
    }

    @Test
    fun searchActivity_withoutSession_noCrash() {
        ActivityScenario.launch(SearchActivity::class.java).use {
            Thread.sleep(1000)
        }
    }

    @Test
    fun queueActivity_withoutSession_noCrash() {
        ActivityScenario.launch(QueueActivity::class.java).use {
            Thread.sleep(1000)
        }
    }

    @Test
    fun sessionsActivity_withoutSession_noCrash() {
        ActivityScenario.launch(SessionsActivity::class.java).use {
            Thread.sleep(1000)
        }
    }
}
