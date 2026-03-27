# How to configure frontend rules in UpCloud Managed Load Balancer

The frontend is the part of the UpCloud Load Balancer that is responsible for accepting incoming requests and forwarding them to the appropriate backend members.

Rules define how the frontend handles incoming traffic and can be configured based on a number of different parameters, providing a high degree of control over how traffic is distributed across your infrastructure.

Frontend rules are made up of two key parts; **Matchers** and **Actions**.

![alt text](image-1.png)

**Matchers** define the conditions under which a rule should be applied. If the incoming request matches the condition specified, then the rule is considered a match, and the associated action or actions are taken. A single rule can have several matchers combined using either the logical "**AND**" or "**OR**" operators for flexible and precise matching. For rules using **AND** logic, all matchers must be met for the rule to be a match. For rules using **OR** logic, only one matcher needs to be met.

**Actions** define what the load balancer does when a rule is matched. Like matchers, a single rule can have several actions. Actions are performed in the order they appear in the list, with those at the top being executed first.

You can change the execution order of actions using the up and down arrow buttons next to each action in the control panel. Moving an action higher in the list increases its priority, while moving it lower decreases its priority.

When a request matches a rule's conditions (matchers), the load balancer performs all associated actions in sequence, starting from the top of the list and working downward.

After completing all actions for that matched rule, the load balancer stops evaluating further rules.

## Matchers

Below is a list of matchers that can be used with frontend rules in the UpCloud Managed Load Balancer:

1. **Source IP**: This matches the IP address where the request originated. It can be used to route traffic from specific IPs or IP ranges differently.
2. **Source port**: This matches the port number on the client side that is used to send the request. It's not commonly used for routing decisions in a typical web application scenario.
3. **Body size**: This matches the size of the request body. For example, you might route larger requests to a different set of servers optimised for handling them.
4. **Cookie**: This matches the presence, absence, or specific value of a cookie included in the request. It is useful for session stickiness, where all requests from a user during a session are routed to the same server.
5. **Header**: This matches the presence, absence, or specific value of an HTTP header in the request. HTTP headers contain meta-information about the request, such as the User-Agent or Accept-Language.
6. **HTTP method**: This matches the HTTP method of the request (e.g., GET, POST, PUT, DELETE). Different methods might be handled by different servers.
7. **HTTP status**: This matches the HTTP status code returned by the server in response to a request (like 200 for success or 404 for not found). It can be used to direct error responses to a dedicated error handling server for example.
8. **URL**: This matches the entire URL of the request. It's typically used in combination with host-based and path-based routing.
9. **URL param**: This matches parameters in the URL of the request. These appear directly in the URL path. For example, in the URL `https://example.com/users/123`, the `123` is a URL parameter that identifies a specific user ID. You might route requests with certain parameters to different servers.
10. **URL query**: This matches the query string part of the URL. This is the the part after the `?`. For example, in `https://example.com/search?term=apple&sort=price`, both `term=apple` and `sort=price` are query parameters. Like URL parameters, queries can also be used to route requests differently based on their content.
11. **Host**: This matches the hostname of the request (the part of the URL before the path). For example, in the URL `https://blog.example.com/articles/recent`, the host is `blog.example.com`. This is often used for host-based routing, where requests to different domains or subdomains are handled by different servers.
12. **Path**: This matches the path of the request (the part of the URL after the hostname). For example, in the URL `https://example.com/products/electronics/phones`, the path is `/products/electronics/phones`.This is used for path-based routing, where requests to different paths are handled by different servers.
13. **Backend members up**: This isn't a typical matcher in the frontend rule but rather a health status indicator of backend servers. The rule only applies if a certain number of backend servers are available and healthy.
14. **Request header**: This matches specific headers in the client's HTTP request. It is useful for advanced routing based on specific header values or patterns, particularly in complex application architectures.
15. **Response header**: This matches headers in the HTTP response returned from backend servers. It allows for routing based on how servers responded.

## Actions

Below are the associated actions that can be used with frontend rules in the UpCloud Managed Load Balancer:

1. **Use backend**: This action tells the load balancer to forward the request to a specific backend server or a group of servers.
2. **HTTP(S) return**: This action instructs the load balancer to respond directly to the client's request with a specific HTTP status code and optionally a response body, instead of forwarding the request to a backend server. This can be useful for certain types of error handling or for creating maintenance pages.
3. **HTTP(S) redirect**: This action tells the load balancer to respond to the client's request with an HTTP redirect (typically a 301 or 302 status code), directing the client to a different URL. When configuring this action, you'll need to choose between two redirect types:
   - **Scheme**: Changes only the protocol (e.g., HTTP to HTTPS) while preserving the rest of the URL. This is ideal for simple HTTP to HTTPS redirections.
   - **Location**: Redirects to a completely different URL that you specify. Useful for redirecting www to non-www URLs, domain migrations, or more complex URL rewriting scenarios.
4. **Reject all TCP**: This action instructs the load balancer to drop all incoming TCP connections that match the rule, without forwarding them to any backend servers. This can be useful for blocking unwanted traffic or for implementing security rules.
5. **Set request header**: This action instructs the load balancer to add or modify HTTP headers in the request before forwarding it to the backend servers. This overrides any existing values for the specified headers. This can be useful for adding authentication headers, normalising request formats across different clients, or passing additional information to backend applications.
6. **Set response header**: This action instructs the load balancer to add or modify HTTP headers in the response before sending it back to the client. This overrides any existing values for the specified headers. Common uses include adding security headers like Content-Security-Policy, setting caching directives, or potentially removing server information by setting headers to alternative values.
7. **Set X-Forwarded Headers**: This action instructs the load balancer to add special "X-Forwarded-\*" headers to the HTTP request before forwarding it to the backend servers. These headers are used to provide the backend servers with information about the original request that came to the load balancer. The three headers added are:
   - **X-Forwarded-For**: This header contains the IP address of the client that made the original request to the load balancer. If the client's request went through multiple proxies before reaching the load balancer, this header will contain a list of those IP addresses.
   - **X-Forwarded-Proto**: This header contains the protocol (HTTP or HTTPS) used by the client in the original request.
   - **X-Forwarded-Port**: This header contains the port on which the original request was received by the load balancer.

Why are X-Forwarded Headers useful? When a load balancer forwards a request to a backend server, the backend server sees the request as coming from the load balancer, not the original client. By including these X-Forwarded-\* headers, the load balancer can pass along information about the original client and request, which can be useful in certain situations such as logging, analytics, or certain types of request handling on the backend servers. When 'Set X-Forwarded Headers' action is selected, the UpCloud Managed Load Balancer overwrites any pre-existing X-Forwarded-\* headers with the correct values to prevent potential spoofing attempts.

## Common use cases for load balancer rules

Below are examples of how you might use matchers and actions for common load balancing scenarios:

### 1. Routing traffic based on path (eg, API vs Frontend)

**Scenario**: Directing API requests to a dedicated backend server group.
**Matcher**: Path (Starts with) `/api/`
**Action**: Use Backend "api-servers"

### 2. HTTP to HTTPS redirection

**Scenario**: Ensuring all traffic uses secure connections.
**Matcher**: Host `example.com` or use no matcher to catch all traffic if the frontend is already configured to listen on port 80 (HTTP)
**Action**: HTTP(S) redirect with type **Scheme** and status code 301

### 3. Host-based routing (Multiple domains)

**Scenario**: Hosting multiple websites on the same load balancer infrastructure.
This require 2 separate rules.
**Matcher - rule 1**: Host `example.com`
**Action**: Use Backend "example-servers"
**Priority**: 1

**Matcher - rule 2**: Host `blog.example.com`
**Action**: Use Backend "blog-servers"
**Priority**: 2

### 4. Preserving client information for backend applications

**Scenario**: Ensuring backend applications have access to original client information (IP address, protocol, port) when behind a load balancer. Without these headers, your backend servers would only see the IP address of the UpCloud Load Balancer in requests and logs, not the original client's IP. This is important for accurate logging, security monitoring, and application functionality that depends on client details.
**Matcher**: You could use no specific matcher to apply this to all traffic, or limit it to specific paths/hosts if needed.
**Action**: Set X-Forwarded Headers

### 5. Maintenance page during planned downtime

**Scenario**: Displaying a maintenance page while backend servers are being updated. This provides a better user experience by showing a friendly message instead of a connection error.
**Matcher**: Backend members up (select a backend) (Less) `1` (adjust based on your environment)
**Action**: HTTP(S) Return with status code 503, content type **text/html**, and response payload containing maintenance message. eg:

```
<!DOCTYPE html>
<html>
<head>
    <title>Maintenance in Progress</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        h1 { color: #333; }
        .container { max-width: 600px; margin: 0 auto; }
    </style>
</head>
<body>
    <div class="container">
        <h1>We're currently undergoing maintenance</h1>
        <p>Our system is being updated to serve you better. We'll be back online shortly.</p>
        <p>Thank you for your patience.</p>
    </div>
</body>
</html>
```

### 6. Static content optimization

**Scenario**: Routing image, CSS, and JS files to specialized static content servers. This improves loading speeds by directing static content to servers optimized for file serving (with efficient caching headers and compression), reduces load on application servers, and can improve cost efficiency by using less expensive compute resources for simple file serving.
**Matcher**: Path (Starts with) `/static/` or `/assets/` or Path (Ends with) `.jpg`, `.png`, `.css`, `.js`
**Action**: Use Backend "static-content-servers"

### 7. A/B testing

**Scenario**: Split traffic between two versions of an application.
This require 2 separate rules.
**Matcher**: Cookie (Exact) "user\_segment" = "A"
**Action**: Use Backend "version-a-servers"
**Priority**: 1

**Matcher**: Cookie (Exact) "user\_segment" = "A" with **Invert value matcher condition** selected
**Action**: Use Backend "version-b-servers"
**Priority**: 2

Using the inverted condition in the second rule means the rule will match whenever the 'user\_segment' cookie either doesn't exist or contains any value other than 'A'.

### 8. Mobile-specific backend

**Scenario**: Directing mobile users to optimized servers while maintaining a single domain name.
**Matcher**: Request header (Regexp) "User-Agent" with value `Mobile|Android|iPhone`
**Action**: Use Backend "mobile-optimized-servers"

### 9. Rate limiting large requests

**Scenario**: Protecting backend servers from unusually large payloads. This prevents server overload by rejecting abnormally large requests before they reach your application servers.
**Matcher**: Body Size (Greater or equal) `10000000` (10MB in bytes)
**Action**: HTTP(S) Return with status code 413, content type **application/json**, and response payload containing message. eg

```
{
  "error": "Payload Too Large",
  "message": "The request body exceeds the maximum allowed size."
}
```

### 10. Backend health probing with custom response

**Scenario**: Customized responses when a backend service is experiencing issues. This improves user experience during partial outages by providing meaningful status information instead of errors.
**Matcher**: Path (Starts with) `/api/critical-service/`
AND
**Matcher**: Backend members up (select backend) (Less) `1`
**Action**: HTTP(S) Return with status code 202, content type **application/json**, and response payload containing message indicating degraded service
content type **text/html**, and response payload containing message. eg:

```
{
  "status": "degraded",
  "message": "The service is currently experiencing high load and may respond more slowly than usual.",
  "estimated_resolution": "within 30 minutes"
}
```

These examples show how The UpCloud Load Balancer rules can be configured to handle different traffic management scenarios, from basic routing to more complex conditional logic based on request characteristics and backend server health.

## Configuring load balancer rules via API

All the rules mentioned above can also be set up programmatically using the UpCloud API. This is especially helpful for automation, infrastructure as code deployments, or when managing multiple load balancers at scale.

Refer to our API documentation for detailed information about configuring [rule matchers](https://developers.upcloud.com/1.3/17-managed-loadbalancer/#rule-matchers) and [rule actions](https://developers.upcloud.com/1.3/17-managed-loadbalancer/#rule-actions) through the API

## Conclusion

The UpCloud Managed Load Balancer provides powerful rule-based traffic management through both the Control Panel and API. With flexible matchers and actions, you can create sophisticated routing strategies to optimise performance, reliability, and security for your applications.

If you require any assistance with configuring your load balancer rules or have questions about optimising your load balancing strategy, our 24/7 support team is available to help.
