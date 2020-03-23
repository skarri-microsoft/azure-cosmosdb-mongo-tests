import os
import uuid
import sys
from azure.storage.blob import BlobServiceClient, BlobClient, ContainerClient, PublicAccess
def upload(conn_str,containerName,blobFileName,localFilePath):
	try:
		blob_service_client = BlobServiceClient.from_connection_string(conn_str=conn_str)
		blob_client = blob_service_client.get_blob_client(container=containerName, blob=blobFileName)
		with open(localFilePath, "rb") as data:
			blob_client.upload_blob(data,overwrite=True)
	except Exception as e:
		print(e)
if __name__ == "__main__":
	args=sys.argv[1:]
	if len(args)<4:
		print('Azure blob upload needs 4 params: connection string,container name,name of the blob and local file full path including file name')
	else:
		connStr=args[0]
		containerName=args[1]
		blobName=args[2]
		localFileFullPath=args[3]
		upload(connStr,containerName,blobName,localFileFullPath)