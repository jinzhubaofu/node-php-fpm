var url     = require('url');
var fs      = require('fs');
var path    = require('path');
var http    = require('http');
var net     = require('net');
var sys     = require('sys');
var fastcgi = require('fastcgi-parser');
var Q       = require('q');

var FCGI_RESPONDER = fastcgi.constants.role.FCGI_RESPONDER;
var FCGI_BEGIN     = fastcgi.constants.record.FCGI_BEGIN;
var FCGI_STDIN     = fastcgi.constants.record.FCGI_STDIN;
var FCGI_STDOUT    = fastcgi.constants.record.FCGI_STDOUT;
var FCGI_PARAMS    = fastcgi.constants.record.FCGI_PARAMS;
var FCGI_END       = fastcgi.constants.record.FCGI_END;

/**
 * Make headers for FPM
 *
 * Some headers have to be modified to fit the FPM
 * handler and some others don't. For instance, the Content-Type
 * header, when received, has to be made upper-case and the
 * hyphen has to be made into an underscore. However, the Accept
 * header has to be made uppercase, hyphens turned into underscores
 * and the string "HTTP_" has to be appended to the header.
 *
 * @param  array headers An array of existing user headers from Node.js
 * @param  array params  An array of pre-built headers set in serveFpm
 *
 * @return array         An array of complete headers.
 */
function makeHeaders(headers, params) {
    if (headers.length <= 0) {
        return params;
    }
    for (var prop in headers) {
        var head = headers[prop];
        prop = prop.replace(/-/, '_').toUpperCase();
        if (prop.indexOf('CONTENT_') < 0) {
            // Quick hack for PHP, might be more or less headers.
            prop = 'HTTP_' + prop;
        }

        params[params.length] = [prop, head]
    }
    return params;
};

module.exports = function (newOptions) {

    // Let's mix those options.
    var options = {
        port: 9000,
        host: 'localhost',
        root: ''
    };

    for (var k in newOptions) {
        options[k] = newOptions[k];
    }

    var debug = options.debug
        ? console
        : {
            log: function () {},
            dir: function () {}
        };

    /**
     * Interact with FPM
     *
     * This function is used to interact with the FastCGI protocol
     * using net.Stream and the fastcgi module.
     *
     * We pass the request, the response, some params and some options
     * that we then use to serve the response to our client.
     *
     * @param object Request  The HTTP Request object.
     * @param object Response The HTTP Response object to use.
     * @param array  Params   A list of parameters to pass to FCGI
     * @param array  options  A list of options like the port of the fpm server.
     *
     * @return void
     */
    function server(request, params, host, port) {

        var defer = Q.defer();

        var connection = new net.Stream();

        connection.setNoDelay(true);

        var connected = false;
        var response = '';
        var collectedStdin = [], noMoreData = false;
        var writer = new fastcgi.writer();
        var writer.encoding = 'binary';
        var header = {
            "version": fastcgi.constants.version,
            "type": FCGI_BEGIN,
            "recordId": 0,
            "contentLength": 0,
            "paddingLength": 0
        };
        var begin = {
            "role": FCGI_RESPONDER,
            "flags": fastcgi.constants.keepalive.OFF
        };

        parser = new fastcgi.parser();

        // 当parser解析出错时
        parser.on('error', function (err) {
            console.log(err);
        });

        // 当parser解析好数据时，存到response里
        parser.on('record', function (record) {
            // 正常输出的数据
            if (record.header.type === FCGI_STDOUT) {
                response += record.body;
                return;
            }
            // 输出结束啦 全剧终
            if (record.header.type === FCGI_END) {
                defer.resolve(response);
            }
        });

        /**
         * 结束向fcgi发送数据包
         */
        function endRequest() {
            // 如果fcgi的连接已建立，那么直接发
            if (connected) {
                header.type = FCGI_STDIN;
                header.contentLength = 0;
                header.paddingLength = 0;
                writer.writeHeader(header)
                connection.write(writer.tobuffer());
                connection.end();
                return;
            }
            // 如果还没建立连接，那么标识一下请求数据流已经结束
            // 当连接建立时，发送完缓存数据后，再来重做一下这个结束动作
            noMoreData = true;
        }

        function sendRequest(connection) {

            // 发送开始头
            header.type = FCGI_BEGIN;
            header.contentLength = 8;
            writer.writeHeader(header);
            writer.writeBegin(begin);
            connection.write(writer.tobuffer());

            // 发送参数
            header.type = FCGI_PARAMS;
            header.contentLength = fastcgi.getParamLength(params);
            writer.writeHeader(header);
            writer.writeParams(params);
            connection.write(writer.tobuffer());

            // 发送参数结束？
            header.type = FCGI_PARAMS;
            header.contentLength = 0;
            writer.writeHeader(header);
            connection.write(writer.tobuffer());

            // header.type = FCGI_STDOUT;
            // writer.writeHeader(header);
            // connection.write(writer.tobuffer());

            // 如果是GET/DELETE就结束鸟
            if (request.method !== 'PUT' && request.method !== 'POST') {
                endRequest();
                return;
            }

            // 否则把body的内容发送过去
            // 如果有缓存的请求数据，那么把他们一包一包地发过去
            for (var i = 0, len = collectedStdin.length; i < len; ++i) {
                header.type = FCGI_STDIN;
                header.contentLength = collectedStdin[i].length;
                header.paddingLength = 0;
                writer.writeHeader(header);
                writer.writeBody(collectedStdin[i]);
                connection.write(writer.tobuffer());
            }

            // 清空缓存
            collectedStdin = [];

            if (noMoreData) {
                endRequest();
            }

        };

        request.on('data', function (chunk) {
            // 如果没有和fcgi建立连接呢，那就缓存起来
            if (!connected) {
                collectedStdin.push(chunk);
                return;
            }
            // 如果已经与fcgi建立了连接呢，那么直接发送了
            header.type = FCGI_STDIN;
            header.contentLength = chunk.length;
            header.paddingLength = 0;
            writer.writeHeader(header);
            writer.writeBody(chunk);
            connection.write(writer.tobuffer());
        });

        request.on('end', endRequest);

        // php-fpm 返回的数据，用parser解析掉
        connection.on('data', function (buffer, start, end) {
            parser.execute(buffer, start, end);
        });

        // 当连接到php-fpm时，初始化writer和parser;
        connection.on('connect', function() {
            connected = true;
            sendRequest(connection);
        });

        // 当与fcgi的连接被关闭时，结束
        connection.on("close", function() {
            if (defer.promise.isPending()) {
                defer.resolve(response);
            }
            connection.end();
        });

        connection.on("error", function(err) {
            sys.puts(sys.inspect(err.stack));
            connection.end();
            if (defer.promise.isPending()) {
                defer.resolve(response);
            }
        });

        connection.connect(options.port, options.host);

        return defer.promise;
    }

    return function (request) {
        var script_dir = options.root;
        var script_file = url.parse(request.url).pathname;
        var request_uri = request.headers['x-request-uri'] ? request.headers['x-request-uri'] : request.url;
        var qs = url.parse(request_uri).query ? url.parse(request_uri).query : '';
        var params = makeHeaders(
            request.headers,
            [
                ["SCRIPT_FILENAME",script_dir + script_file],
                ["REMOTE_ADDR",request.connection.remoteAddress],
                ["QUERY_STRING", qs],
                ["REQUEST_METHOD", request.method],
                ["SCRIPT_NAME", script_file],
                ["PATH_INFO", script_file],
                ["DOCUMENT_URI", script_file],
                ["REQUEST_URI", request_uri],
                ["DOCUMENT_ROOT", script_dir],
                ["PHP_SELF", script_file],
                ["GATEWAY_PROTOCOL", "CGI/1.1"],
                ["SERVER_SOFTWARE", "node/" + process.version]
            ]
        );

        debug.log('Incoming Request: ' + request.method + ' ' + request.url);
        debug.dir(params);
        server(request, params, options.host, options.port);
    };
}
