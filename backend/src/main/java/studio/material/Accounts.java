package studio.material;

import java.io.Serializable;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DuplicateKeyException;
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
record Registration(String username, String displayName, String password) {}

@Mapper
interface UserMapper {
    @Select("SELECT id, username, display_name, password_hash FROM users WHERE username = #{username}")
    User find(String username);

    @Insert("INSERT INTO users (username, display_name, password_hash) VALUES (#{username}, #{displayName}, #{passwordHash})")
    void insert(String username, String displayName, String passwordHash);
}

@Service
class Accounts {
    private static final String SESSION_USER = "studio.user";
    private static final Pattern USERNAME = Pattern.compile("[a-z0-9][a-z0-9_-]{2,39}");
    private final UserMapper users;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    Accounts(UserMapper users) {
        this.users = users;
    }

    UserView login(Login credentials, HttpServletRequest request) {
        String username = normalizeUsername(credentials.username());
        String password = credentials.password();
        User user = USERNAME.matcher(username).matches() && passwordFits(password) ? users.find(username) : null;
        if (user == null || !encoder.matches(password, user.passwordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "账号或密码错误。");
        }
        return startSession(user, request);
    }

    UserView register(Registration registration, HttpServletRequest request) {
        String username = normalizeUsername(registration.username());
        String name = registration.displayName() == null ? "" : registration.displayName().strip();
        String password = registration.password();
        if (!USERNAME.matcher(username).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "用户名须为 3–40 个英文字母、数字、下划线或连字符，并以英文字母或数字开头。");
        }
        if (name.isEmpty() || name.codePointCount(0, name.length()) > 80 || name.codePoints().anyMatch(Character::isISOControl)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请输入 1–80 个字符的显示名称。");
        }
        if (!passwordFits(password) || password.codePointCount(0, password.length()) < 8 || password.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码至少 8 个字符，UTF-8 编码最多 72 字节。");
        }
        try {
            users.insert(username, name, encoder.encode(password));
        } catch (DuplicateKeyException error) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "该用户名已被使用。");
        }
        return startSession(users.find(username), request);
    }

    private static String normalizeUsername(String username) {
        return username == null ? "" : username.strip().toLowerCase(Locale.ROOT);
    }

    private static boolean passwordFits(String password) {
        return password != null && password.length() <= 72 && password.getBytes(StandardCharsets.UTF_8).length <= 72;
    }

    private UserView startSession(User user, HttpServletRequest request) {
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
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录账号。");
        }
        String expected = request.getHeader("X-Studio-Account");
        if (expected != null && !expected.equals(user.username())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "账号已切换，请重试。");
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

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    Map<String, UserView> register(@RequestBody Registration registration, HttpServletRequest request) {
        return Map.of("user", accounts.register(registration, request));
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
