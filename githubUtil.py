from github import Github
import github
import datetime
def uploadToGithub(user,personalOAuthToken,email,branch,commitMsg,repoName,localFilePath,remoteUploadFilePath):
    g = Github(user, personalOAuthToken)
    r=g.get_repo(user+"/"+repoName)
    updatedTime=datetime.datetime.now().replace(microsecond=0).isoformat()
    requiredFile=r.get_contents(remoteUploadFilePath)
    content=""
    with open(localFilePath, 'r') as content_file:
        content = content_file.read()
    r.update_file(path=remoteUploadFilePath,
    message=commitMsg,
    content=content,
    sha=requiredFile.sha,
    branch=branch,
    committer=github.InputGitAuthor(
                user, email, updatedTime
            ),
    author=github.InputGitAuthor(
            user, email, updatedTime
            ))
if __name__ == "__main__":
    args=sys.argv[1:]
    if len(args)<8:
        print('Github upload needs 8 params: user,personalOAuthToken,email,branch,commitMsg,repoName,localFilePath,remoteUploadFilePath')
    else:
        uploadToGithub(args[0],args[1],args[2],args[3],args[4],args[5],args[6],args[7])