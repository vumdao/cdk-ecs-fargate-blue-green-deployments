FROM public.ecr.aws/nginx/nginx:alpine

ENV USER=nginx \
    GROUP=nginx

COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html

RUN chmod +r /etc/resolv.conf && \
    mkdir -p /var/log/nginx /var/cache/nginx && \
    chown -R ${USER}:${GROUP} /etc/nginx /var/log/nginx /var/cache/nginx

WORKDIR /etc/nginx

USER $USER

EXPOSE 8080

ENTRYPOINT ["nginx", "-g", "daemon off;"]
