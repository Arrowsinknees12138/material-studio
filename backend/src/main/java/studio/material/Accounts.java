package studio.material;

import java.io.Serializable;
import java.util.Map;
import java.util.Set;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

record User(long id, String username, String displayName, String passwordHash) {}
record SessionUser(long id, String username, String displayName) implements Serializable {}
record UserView(String username, String displayName) {}
record Login(String username, String password) {}

@Mapper
interface UserMapper {
    @Select("SELECT id, username, display_name, password_hash FROM users WHERE username = #{username}")
    User find(String username);
}

@Service
class Accounts {
    private static final String SESSION_USER = "studio.user";
    private final UserMapper users;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    Accounts(UserMapper users) {
        this.users = users;
    }

    UserView login(Login credentials, HttpServletRequest request) {
        User user = credentials.username() == null ? null : users.find(credentials.username());
        String password = credentials.password();
        if (user == null || password == null || password.length() > 72
                || !encoder.matches(password, user.passwordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "账号或密码错误。");
        }
        logout(request);
        request.getSession(true).setAttribute(SESSION_USER,
                new SessionUser(user.id(), user.username(), user.displayName()));
        return new UserView(user.username(), user.displayName());
    }

    SessionUser current(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        return session == null ? null : (SessionUser) session.getAttribute(SESSION_USER);
    }

    long requireOwner(HttpServletRequest request) {
        SessionUser user = current(request);
        if (user == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录演示账号。");
        }
        return user.id();
    }

    void logout(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
    }
}

@RestController
@RequestMapping("/api/session")
class SessionController {
    private final Accounts accounts;

    SessionController(Accounts accounts) {
        this.accounts = accounts;
    }

    @GetMapping
    Map<String, UserView> current(HttpServletRequest request) {
        SessionUser user = accounts.current(request);
        return user == null ? java.util.Collections.singletonMap("user", null)
                : Map.of("user", new UserView(user.username(), user.displayName()));
    }

    @PostMapping
    Map<String, UserView> login(@RequestBody Login login, HttpServletRequest request) {
        return Map.of("user", accounts.login(login, request));
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void logout(HttpServletRequest request) {
        accounts.logout(request);
    }
}

@Configuration
class ApiRequestGuard implements WebMvcConfigurer {
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new org.springframework.web.servlet.HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request, jakarta.servlet.http.HttpServletResponse response,
                                     Object handler) {
                // Cross-origin browser requests cannot attach this header without a CORS preflight.
                if (!SAFE_METHODS.contains(request.getMethod()) && !"1".equals(request.getHeader("X-Studio-Request"))) {
                    throw new ResponseStatusException(HttpStatus.FORBIDDEN, "请求缺少操作标记。");
                }
                return true;
            }
        }).addPathPatterns("/api/**");
    }
}
