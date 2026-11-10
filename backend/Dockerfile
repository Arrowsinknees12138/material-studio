FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml ./
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B verify

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN mkdir /app/data && chown -R 10001:10001 /app
COPY --from=build /build/target/material-studio.jar ./material-studio.jar
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "material-studio.jar"]
