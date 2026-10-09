FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund --loglevel=error
COPY hirefire-resource.tgz ./
RUN npm install ./hirefire-resource.tgz --no-audit --no-fund --loglevel=error
ARG NEXT_MAJORS="14 15 16"
ARG NEXT_EXTRA=""
COPY next /next-template
RUN for major in $NEXT_MAJORS; do \
      cp -R /next-template /next$major && cd /next$major && \
      if [ "$major" = "16" ]; then grep -v "export const config" middleware.js > proxy.js && rm middleware.js; fi && \
      npm install next@$major react react-dom /app/hirefire-resource.tgz $NEXT_EXTRA --no-audit --no-fund --loglevel=error; \
    done
COPY . .
CMD ["node", "run.js"]
