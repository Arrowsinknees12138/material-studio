package studio.material;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.http.HttpStatus.NOT_FOUND;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest({SessionController.class, TaskController.class})
@Import({Accounts.class, ApiRequestGuard.class})
class TaskHttpTest {
    private static final long OWNER = 7L;
    private static final UUID REQUEST_ID = UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final String ASSET_ID = "aaaaaaaa-0000-4000-8000-000000000001";
    private static final String TASK_ID = "bbbbbbbb-0000-4000-8000-000000000002";
    private static final Instant CREATED = Instant.parse("2026-01-01T00:00:00Z");
    private static final String SUBMISSION = """
            {"templateId":"moon","assetIds":["%s"],"requestId":"%s"}
            """.formatted(ASSET_ID, REQUEST_ID);

    @Autowired MockMvc mvc;
    @MockitoBean UserMapper users;
    @MockitoBean Tasks tasks;
    @MockitoBean FileStorage storage;

    @Test
    void registrationHashesPasswordAndReplacesTheCurrentSession() throws Exception {
        MockHttpSession old = signIn();
        doAnswer(invocation -> {
            String hash = invocation.getArgument(2);
            assertNotEquals("personal-secret", hash);
            assertTrue(new BCryptPasswordEncoder().matches("personal-secret", hash));
            when(users.find("alice-1")).thenReturn(new User(12L, "alice-1", "爱丽丝", hash));
            return null;
        }).when(users).insert(eq("alice-1"), eq("爱丽丝"), anyString());

        var response = mvc.perform(post("/api/session/register").session(old).header("X-Studio-Request", "1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"username":" Alice-1 ","displayName":" 爱丽丝 ","password":"personal-secret"}
                                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.user.username").value("alice-1"))
                .andExpect(jsonPath("$.user.displayName").value("爱丽丝"))
                .andExpect(jsonPath("$.user.password").doesNotExist())
                .andReturn();
        var session = (MockHttpSession) response.getRequest().getSession(false);
        assertTrue(old.isInvalid());
        assertNotNull(session);
        assertNotEquals(old.getId(), session.getId());
        mvc.perform(get("/api/session").session(session))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.username").value("alice-1"));
    }

    @Test
    void duplicateRegistrationPreservesTheCurrentSession() throws Exception {
        MockHttpSession session = signIn();
        doThrow(new DuplicateKeyException("duplicate")).when(users).insert(eq("lin"), anyString(), anyString());

        mvc.perform(post("/api/session/register").session(session).header("X-Studio-Request", "1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"username":"LIN","displayName":"Other","password":"personal-secret"}
                                """))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.message").value("该用户名已被使用。"));
        assertFalse(session.isInvalid());
        mvc.perform(get("/api/session").session(session))
                .andExpect(jsonPath("$.user.username").value("lin"));
    }

    @Test
    void writeRequestsRequireTheOperationHeaderAndNeverReachTheServiceWithoutIt() throws Exception {
        mvc.perform(post("/api/tasks").session(signIn())
                        .contentType(MediaType.APPLICATION_JSON).content(SUBMISSION))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.message").value("请求缺少操作标记。"));

        verifyNoInteractions(tasks);
    }

    @Test
    void acceptsAQueuedTaskForTheSessionOwner() throws Exception {
        Task queued = new Task(TASK_ID, OWNER, "moon", "Moon", REQUEST_ID.toString(), TaskStatus.QUEUED,
                null, CREATED, null, null, null, null, 10, 20, 30);
        when(tasks.submit(OWNER, new Submission("moon", List.of(ASSET_ID), REQUEST_ID, null, null)))
                .thenReturn(queued.view());

        mvc.perform(post("/api/tasks").session(signIn()).header("X-Studio-Request", "1")
                        .header("X-Studio-Account", "lin").contentType(MediaType.APPLICATION_JSON).content(SUBMISSION))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.id").value(TASK_ID))
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.createdAt").value(CREATED.toString()))
                .andExpect(jsonPath("$.stage").isEmpty())
                .andExpect(jsonPath("$.resultUrl").isEmpty());
    }

    @Test
    void rejectsAnonymousAndStaleAccountReadsBeforeAccessingHistory() throws Exception {
        mvc.perform(get("/api/tasks/history"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.message").value("请先登录账号。"));
        mvc.perform(get("/api/tasks/history").session(signIn()).header("X-Studio-Account", "zhou"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.message").value("账号已切换，请重试。"));

        verifyNoInteractions(tasks);
    }

    @Test
    void translatesUnavailableAssetsIntoStructuredClientFeedback() throws Exception {
        when(tasks.submit(OWNER, new Submission("moon", List.of(ASSET_ID), REQUEST_ID, null, null)))
                .thenThrow(new UnavailableAssets(List.of(ASSET_ID)));

        mvc.perform(post("/api/tasks").session(signIn()).header("X-Studio-Request", "1")
                        .contentType(MediaType.APPLICATION_JSON).content(SUBMISSION))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").isString())
                .andExpect(jsonPath("$.unavailableAssetIds.length()").value(1))
                .andExpect(jsonPath("$.unavailableAssetIds[0]").value(ASSET_ID));
    }

    @Test
    void rejectsMalformedSubmissionBeforeInvokingTheService() throws Exception {
        mvc.perform(post("/api/tasks").session(signIn()).header("X-Studio-Request", "1")
                        .contentType(MediaType.APPLICATION_JSON).content(SUBMISSION.replace(REQUEST_ID.toString(), "bad")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("请求缺少必要字段或字段格式无效。"));

        verifyNoInteractions(tasks);
    }

    @ParameterizedTest
    @ValueSource(strings = {"\"delayMs\":1.5", "\"delayMs\":1.0", "\"delayMs\":\"1\"", "\"delayMs\":true",
            "\"delayMs\":2147483648", "\"failAt\":1", "\"failAt\":\"1\"", "\"failAt\":\"UNKNOWN\""})
    void rejectsInvalidSimulationFieldsBeforeInvokingTheService(String fields) throws Exception {
        mvc.perform(post("/api/tasks").session(signIn()).header("X-Studio-Request", "1")
                        .contentType(MediaType.APPLICATION_JSON).content(submissionWith(fields)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("请求缺少必要字段或字段格式无效。"));

        verifyNoInteractions(tasks);
    }

    @Test
    void treatsExplicitNullSimulationFieldsAsOmitted() throws Exception {
        mvc.perform(post("/api/tasks").session(signIn()).header("X-Studio-Request", "1")
                        .contentType(MediaType.APPLICATION_JSON).content(submissionWith("\"failAt\":null,\"delayMs\":null")))
                .andExpect(status().isAccepted());

        verify(tasks).submit(OWNER, new Submission("moon", List.of(ASSET_ID), REQUEST_ID, null, null));
    }

    @Test
    void doesNotReadFilesForInProgressOrUnownedTasks() throws Exception {
        MockHttpSession session = signIn();
        when(tasks.requireOwned(OWNER, TASK_ID)).thenReturn(new Task(TASK_ID, OWNER, "moon", "Moon",
                REQUEST_ID.toString(), TaskStatus.RUNNING, TaskStage.FINALIZE, CREATED, null, null, null,
                null, 10, 20, 30));
        when(tasks.requireOwned(OWNER, "foreign"))
                .thenThrow(new ResponseStatusException(NOT_FOUND, "未找到该任务。"));

        mvc.perform(get("/api/tasks/{id}/result", TASK_ID).session(session))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.message").value("该任务暂无可预览结果。"));
        mvc.perform(get("/api/tasks/{id}/result", "foreign").session(session))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.message").value("未找到该任务。"));
        verifyNoInteractions(storage);
    }

    @Test
    void streamsTheOwnersFinishedResult() throws Exception {
        String key = "results/" + TASK_ID + ".jpg";
        byte[] jpeg = {(byte) 0xff, (byte) 0xd8, (byte) 0xff};
        when(tasks.requireOwned(OWNER, TASK_ID)).thenReturn(new Task(TASK_ID, OWNER, "moon", "Moon",
                REQUEST_ID.toString(), TaskStatus.SUCCEEDED, TaskStage.FINALIZE, CREATED, CREATED.plusSeconds(1),
                key, null, null, 10, 20, 30));
        when(storage.serve(key, "image/jpeg")).thenReturn(ResponseEntity.ok().contentType(MediaType.IMAGE_JPEG)
                .body(new ByteArrayResource(jpeg)));

        mvc.perform(get("/api/tasks/{id}/result", TASK_ID).session(signIn()))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_JPEG))
                .andExpect(content().bytes(jpeg));
    }

    @Test
    void changesTheSessionOnAccountSwitchAndInvalidatesItOnLogout() throws Exception {
        MockHttpSession original = signIn();
        MockHttpSession switched = signIn("zhou", 8L, original);
        assertTrue(original.isInvalid());
        assertNotEquals(original.getId(), switched.getId());

        mvc.perform(get("/api/session").session(switched))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.username").value("zhou"));
        mvc.perform(post("/api/session/logout").session(switched).header("X-Studio-Request", "1"))
                .andExpect(status().isNoContent());
        assertTrue(switched.isInvalid());
    }

    private MockHttpSession signIn() throws Exception {
        return signIn("lin", OWNER, new MockHttpSession());
    }

    private static String submissionWith(String fields) {
        String body = SUBMISSION.stripTrailing();
        return body.substring(0, body.length() - 1) + "," + fields + "}";
    }

    private MockHttpSession signIn(String username, long id, MockHttpSession existing) throws Exception {
        String passwordHash = new BCryptPasswordEncoder(4).encode("studio-demo");
        when(users.find(username)).thenReturn(new User(id, username, username, passwordHash));
        return (MockHttpSession) mvc.perform(post("/api/session").session(existing)
                        .header("X-Studio-Request", "1").contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"username":"%s","password":"studio-demo"}
                                """.formatted(username)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.user.username").value(username))
                .andReturn().getRequest().getSession(false);
    }
}
